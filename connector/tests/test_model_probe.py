from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from connector.runtime_protocol.model_connection import ModelConnectionCapability
from connector.runtime_protocol.model_probe import probe_model_connection
from connector.runtimes.acp.profiles.pi.provider import (
    MODEL_CONNECTION as PI_MODEL_CONNECTION,
)
from connector.runtimes.claude.provider import (
    MODEL_CONNECTION as CLAUDE_MODEL_CONNECTION,
)
from connector.runtimes.codex.provider import MODEL_CONNECTION as CODEX_MODEL_CONNECTION

API_KEY = "sk-probe-secret"


def _values(base_url: str = "https://gw.example/v1", **extra: Any) -> dict[str, Any]:
    return {
        "modelGateway": {"baseUrl": base_url, "apiKey": API_KEY},
        "customModels": [{"modelId": "m-first"}, {"modelId": "m-second"}],
        **extra,
    }


def _probe(
    values: dict[str, Any] | None,
    capability: ModelConnectionCapability | None,
    handler,
):
    return asyncio.run(
        probe_model_connection(values, capability, transport=httpx.MockTransport(handler))
    )


def _recording(status: int = 200, body: Any = None):
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(status, json={"id": "x"} if body is None else body)

    return requests, handler


@pytest.mark.parametrize(
    ("capability", "base_url", "url"),
    [
        (CODEX_MODEL_CONNECTION, "https://gw.example/v1", "https://gw.example/v1/responses"),
        (CLAUDE_MODEL_CONNECTION, "https://gw.example/anthropic/", "https://gw.example/anthropic/v1/messages"),
        (PI_MODEL_CONNECTION, "https://gw.example/v1", "https://gw.example/v1/chat/completions"),
    ],
)
def test_probe_calls_each_protocol_like_its_runtime(
    capability: ModelConnectionCapability, base_url: str, url: str
) -> None:
    requests, handler = _recording()

    result = _probe(_values(base_url), capability, handler)

    assert result.state == "passed"
    assert result.model == "m-first"
    assert result.protocol == capability.protocols[0]
    assert [str(request.url) for request in requests] == [url]
    assert requests[0].headers["authorization"] == f"Bearer {API_KEY}"
    assert json.loads(requests[0].content)["model"] == "m-first"


def test_probe_prefers_the_runtime_model_setting_and_gateway_protocol() -> None:
    requests, handler = _recording()
    values = _values(model={"modelId": "m-second"})
    values["modelGateway"]["protocol"] = "openai_chat"

    result = _probe(values, CODEX_MODEL_CONNECTION, handler)

    assert (result.state, result.model, result.protocol) == ("passed", "m-second", "openai_chat")
    assert str(requests[0].url).endswith("/chat/completions")


def test_probe_retries_chat_with_max_completion_tokens() -> None:
    bodies: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        if "max_tokens" in body:
            return httpx.Response(400, json={"error": {"message": "Unsupported parameter: 'max_tokens'"}})
        return httpx.Response(200, json={"choices": []})

    result = _probe(_values(), PI_MODEL_CONNECTION, handler)

    assert result.state == "passed"
    assert "max_completion_tokens" in bodies[1]


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (401, "probe_unauthorized"),
        (403, "probe_unauthorized"),
        (404, "probe_not_found"),
        (429, "probe_rate_limited"),
        (400, "probe_rejected"),
        (502, "probe_upstream_error"),
    ],
)
def test_probe_maps_http_failures(status: int, code: str) -> None:
    _requests, handler = _recording(
        status, {"error": {"message": f"bad key {API_KEY}"}}
    )

    result = _probe(_values(), CODEX_MODEL_CONNECTION, handler)

    assert (result.state, result.code) == ("failed", code)
    assert result.message is not None
    assert API_KEY not in result.message
    assert f"HTTP {status}" in result.message


def test_probe_reports_unreachable_and_timeout() -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    assert _probe(_values(), CODEX_MODEL_CONNECTION, refuse).code == "probe_unreachable"
    assert _probe(_values(), CODEX_MODEL_CONNECTION, slow).code == "probe_timeout"


def test_probe_rejects_a_reply_that_is_not_a_model_response() -> None:
    def html(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>login</html>")

    _requests, error_body = _recording(200, {"error": "quota"})

    assert _probe(_values(), CODEX_MODEL_CONNECTION, html).code == "probe_invalid_response"
    assert _probe(_values(), CODEX_MODEL_CONNECTION, error_body).code == "probe_invalid_response"


def test_probe_is_skipped_without_a_connection_or_a_known_model() -> None:
    requests, handler = _recording()

    native = _probe({"customModels": []}, CODEX_MODEL_CONNECTION, handler)
    unsupported = _probe(_values(), None, handler)
    no_model = _probe(_values(customModels=[]), CLAUDE_MODEL_CONNECTION, handler)

    assert (native.state, native.code) == ("skipped", "not_configured")
    assert (unsupported.state, unsupported.code) == ("skipped", "model_connection_unsupported")
    assert (no_model.state, no_model.code) == ("skipped", "model_unknown")
    assert requests == []
