from __future__ import annotations

import base64
import os
from collections.abc import Callable, Mapping
from typing import Any

from jsonschema import Draft202012Validator

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInvalidRequestError,
    RuntimeProvider,
    RuntimeSourceKey,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.opencode import provider_config, serve_process
from connector.runtimes.opencode.runtime import OpenCodeRuntime

OPENCODE_CONFIG_SCHEMA_REVISION = 2

Prober = Callable[[], dict[str, Any]]


def _serve_credentials() -> tuple[str | None, str]:
    """Basic-auth credentials an auto-started serve inherits from the environment.

    ``opencode serve`` protects itself with HTTP Basic and answers every route
    (including the health probe ``/api/info``) with 401 unless the matching
    credentials are sent. The password is optional (a serve started without one
    invents its own), so a missing password yields no Authorization header
    rather than a broken one.
    """

    return serve_process.environment_server_credentials(os.environ)


def default_probe() -> dict[str, Any]:
    """Reachability probe for a serve instance at the configured URL.

    Runs synchronously against the default config values; discovery is a
    lightweight config-time check, not a turn-critical path. Credentials come
    from the runtime config, then the environment, then — for a serve this
    connector auto-started — the password auto-start generated (discovery has no
    runtime instance to ask, and an unauthenticated probe would 401).
    """

    values = provider_config.default_config_values()
    server_url = str(values["serverUrl"])
    env_user, env_key = _serve_credentials()
    started_user, started_key = serve_process.registered_serve_credentials(server_url)
    return _probe_url(
        server_url,
        api_user=str(values.get("apiUser") or env_user or started_user or "opencode"),
        api_key=str(values.get("apiKey") or env_key or started_key or ""),
    )


def _probe_url(url: str, *, api_user: str = "opencode", api_key: str = "") -> dict[str, Any]:
    import httpx

    headers: dict[str, str] = {}
    if api_key:
        token = base64.b64encode(f"{api_user}:{api_key}".encode()).decode()
        headers["Authorization"] = f"Basic {token}"
    try:
        # opencode 2.x only speaks ``/api/*``; unknown routes fall through to the
        # web UI with HTTP 200 + HTML, which would read as a healthy 1.x serve.
        response = httpx.get(f"{url.rstrip('/')}/api/info", headers=headers, timeout=5.0)
        if response.status_code == 200:
            content_type = response.headers.get("content-type", "")
            if "html" in content_type.lower() or response.text.lstrip()[:64].lower().startswith(
                ("<!doctype html", "<html")
            ):
                return {
                    "available": False,
                    "status": 200,
                    "reason": "this opencode does not expose the V2 API (/api/info)",
                }
            payload = response.json() if response.content else {}
            return {
                "available": True,
                "version": str(payload.get("version") or "unknown"),
            }
        if response.status_code == 401:
            # Reachable but credentialed and we could not authenticate: the
            # instance is up, so report it with a reason instead of "unreachable".
            return {"available": False, "status": 401, "reason": "authentication required"}
        return {"available": False, "status": response.status_code}
    except httpx.HTTPError:
        return {"available": False}


class OpenCodeProvider(RuntimeProvider):
    def __init__(self, prober: Prober | None = None) -> None:
        self._prober = prober or default_probe

    @property
    def runtime(self) -> str:
        return "opencode"

    @property
    def runtime_type(self) -> str:
        return "opencode"

    @property
    def display_name(self) -> str:
        return "OpenCode"

    @property
    def description(self) -> str:
        return "OpenCode serve runtime (REST + SSE)"

    @property
    def implementation_type(self) -> str:
        return "local-service"

    async def discover(self) -> RuntimeTypeDescriptor:
        probe = self._prober()
        available = bool(probe.get("available"))
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            description=self.description,
            implementation_type=self.implementation_type,
            available=available,
            capabilities=provider_config.opencode_capabilities(),
            reason=None if available else "opencode serve is not reachable at the configured URL",
            config_schema=await self.get_config_schema(),
            metadata={
                "configured": available,
                "probe": probe,
            },
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        return RuntimeConfigSchema(
            runtime=self.runtime,
            revision=OPENCODE_CONFIG_SCHEMA_REVISION,
            schema=provider_config.opencode_config_schema(),
ui_schema={
                    "order": [
                        "serverUrl",
                        "apiKey",
                        "apiUser",
                        "requestTimeoutSeconds",
                        "autoStart",
                    ],
                },
            defaults=provider_config.default_config_values(),
        )

    async def validate_config(
        self,
        values: Mapping[str, Any],
    ) -> RuntimeConfig:
        normalized = provider_config.normalized_config_values(dict(values))
        schema = provider_config.opencode_config_schema()
        errors = sorted(
            Draft202012Validator(schema).iter_errors(normalized),
            key=lambda error: list(error.absolute_path),
        )
        if errors:
            path = "/" + "/".join(str(part) for part in errors[0].absolute_path)
            raise RuntimeInvalidRequestError(
                f"opencode config is invalid at {path or '/'}: {errors[0].message}"
            )
        return RuntimeConfig(
            runtime=self.runtime,
            revision=OPENCODE_CONFIG_SCHEMA_REVISION,
            values=normalized,
            schema=schema,
            ui_schema={"order": ["serverUrl", "apiKey", "apiUser", "requestTimeoutSeconds"]},
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        return OpenCodeRuntime(config=config, host=host)

    def session_source_key(self, config: RuntimeConfig) -> RuntimeSourceKey:
        url = str(config.values.get("serverUrl") or provider_config.DEFAULT_SERVER_URL).rstrip("/")
        return RuntimeSourceKey(
            kind="opencode_server",
            key=url,
        )
