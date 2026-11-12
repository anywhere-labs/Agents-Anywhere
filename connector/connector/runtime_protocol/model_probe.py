"""Real-call probe for the model connection a runtime instance loaded.

A started process only proves the runtime read its configuration. A channel
switch is confirmed by sending one minimal model request with exactly the
address, key, protocol and model the new instance runs with, and counting the
switch as done only when a valid reply comes back. The probe costs a few
tokens.

The probe reads the configuration from the running instance, never from the
request, and never reports the API key.

See the Runtime Control 2.1 contract (``runtime.probeModelConnection``).
"""

from __future__ import annotations

import json
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal

import httpx

from connector.runtime_protocol.model_connection import (
    ModelConnectionCapability,
    connection_configured,
)

MODEL_PROBE_FEATURE = "modelProbe"
PROBE_TIMEOUT_SECONDS = 30.0
PROBE_PROMPT = "Reply with OK."
PROBE_OUTPUT_TOKENS = 16
MAX_PROBE_MESSAGE_LENGTH = 300

ProbeState = Literal["passed", "failed", "skipped"]


@dataclass(frozen=True, slots=True)
class ModelProbeResult:
    state: ProbeState
    protocol: str | None = None
    model: str | None = None
    latency_ms: int | None = None
    code: str | None = None
    message: str | None = None

    def payload(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "protocol": self.protocol,
            "model": self.model,
            "latencyMs": self.latency_ms,
            "code": self.code,
            "message": self.message,
        }


@dataclass(frozen=True, slots=True)
class _ProbeTarget:
    base_url: str
    api_key: str
    protocol: str
    model: str


def probe_target(
    values: Mapping[str, Any] | None,
    capability: ModelConnectionCapability | None,
) -> _ProbeTarget | ModelProbeResult:
    """What to call, or the result when there is nothing to probe."""

    if capability is None:
        return ModelProbeResult("skipped", code="model_connection_unsupported")
    if values is None or not connection_configured(values, capability.config_field):
        return ModelProbeResult("skipped", code="not_configured")
    gateway = values[capability.config_field]
    protocol = gateway.get("protocol") or capability.protocols[0]
    model = _probe_model(values, capability)
    if model is None:
        # Without a model list the runtime falls back to its own default
        # model name, which AA cannot know; the start checks still apply.
        return ModelProbeResult("skipped", protocol=protocol, code="model_unknown")
    return _ProbeTarget(
        base_url=str(gateway["baseUrl"]).rstrip("/"),
        api_key=str(gateway.get("apiKey") or ""),
        protocol=protocol,
        model=model,
    )


async def probe_model_connection(
    values: Mapping[str, Any] | None,
    capability: ModelConnectionCapability | None,
    *,
    timeout: float = PROBE_TIMEOUT_SECONDS,
    transport: httpx.AsyncBaseTransport | None = None,
) -> ModelProbeResult:
    target = probe_target(values, capability)
    if isinstance(target, ModelProbeResult):
        return target
    started = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=timeout, transport=transport) as client:
            response = await _send(client, target)
    except httpx.TimeoutException:
        return _failed(target, started, "probe_timeout", "the model endpoint did not answer in time")
    except httpx.HTTPError as exc:
        return _failed(
            target,
            started,
            "probe_unreachable",
            _scrub(f"could not reach the model endpoint: {exc.__class__.__name__}", target.api_key),
        )
    if not response.is_success:
        return _failed(
            target,
            started,
            _status_code(response.status_code),
            _scrub(
                f"HTTP {response.status_code}: {_upstream_message(response)}",
                target.api_key,
            ),
        )
    try:
        body = response.json()
    except ValueError:
        body = None
    if not isinstance(body, dict) or body.get("error"):
        return _failed(
            target,
            started,
            "probe_invalid_response",
            "the model endpoint did not return a model reply",
        )
    return ModelProbeResult(
        "passed",
        protocol=target.protocol,
        model=target.model,
        latency_ms=_elapsed(started),
    )


async def _send(client: httpx.AsyncClient, target: _ProbeTarget) -> httpx.Response:
    headers = {
        "Authorization": f"Bearer {target.api_key}",
        "Content-Type": "application/json",
    }
    if target.protocol == "anthropic":
        # The same URL and bearer token Claude Code uses with ANTHROPIC_BASE_URL.
        return await client.post(
            f"{target.base_url}/v1/messages",
            headers={**headers, "anthropic-version": "2023-06-01"},
            json={
                "model": target.model,
                "max_tokens": PROBE_OUTPUT_TOKENS,
                "messages": [{"role": "user", "content": PROBE_PROMPT}],
            },
        )
    if target.protocol == "openai_responses":
        return await client.post(
            f"{target.base_url}/responses",
            headers=headers,
            json={
                "model": target.model,
                "input": PROBE_PROMPT,
                "max_output_tokens": PROBE_OUTPUT_TOKENS,
                "store": False,
            },
        )
    body = {
        "model": target.model,
        "messages": [{"role": "user", "content": PROBE_PROMPT}],
        "max_tokens": PROBE_OUTPUT_TOKENS,
    }
    response = await client.post(f"{target.base_url}/chat/completions", headers=headers, json=body)
    if response.status_code == 400 and "max_tokens" in response.text:
        # Newer OpenAI models only take max_completion_tokens.
        body.pop("max_tokens")
        body["max_completion_tokens"] = PROBE_OUTPUT_TOKENS
        response = await client.post(f"{target.base_url}/chat/completions", headers=headers, json=body)
    return response


def _probe_model(
    values: Mapping[str, Any],
    capability: ModelConnectionCapability,
) -> str | None:
    models_field = capability.models_field
    raw_models = values.get(models_field) if models_field else None
    model_ids = [
        item["modelId"]
        for item in raw_models or ()
        if isinstance(item, Mapping) and isinstance(item.get("modelId"), str) and item["modelId"]
    ]
    if capability.model_field:
        setting = values.get(capability.model_field)
        chosen = setting.get("modelId") if isinstance(setting, Mapping) else None
        if isinstance(chosen, str) and chosen and (not model_ids or chosen in model_ids):
            return chosen
    return model_ids[0] if model_ids else None


def _status_code(status: int) -> str:
    if status in {401, 403}:
        return "probe_unauthorized"
    if status == 404:
        return "probe_not_found"
    if status == 429:
        return "probe_rate_limited"
    if status >= 500:
        return "probe_upstream_error"
    return "probe_rejected"


def _upstream_message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.reason_phrase or "request failed"
    error = body.get("error") if isinstance(body, dict) else None
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        return error["message"]
    if isinstance(error, str):
        return error
    if isinstance(body, dict) and isinstance(body.get("message"), str):
        return body["message"]
    return json.dumps(body, ensure_ascii=False)[:MAX_PROBE_MESSAGE_LENGTH]


def _scrub(message: str, api_key: str) -> str:
    if api_key:
        message = message.replace(api_key, "***")
    return message[:MAX_PROBE_MESSAGE_LENGTH]


def _failed(target: _ProbeTarget, started: float, code: str, message: str) -> ModelProbeResult:
    return ModelProbeResult(
        "failed",
        protocol=target.protocol,
        model=target.model,
        latency_ms=_elapsed(started),
        code=code,
        message=message,
    )


def _elapsed(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
