from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from connector.adapter import Adapter
from connector.launch import launch_target
from connector.runtime_lifecycle import (
    CodexRuntimeProvider,
    EffectiveRuntimeConfig,
    RuntimeBindings,
    RuntimeConfigError,
    RuntimeInactiveError,
    RuntimeSupervisor,
)
from connector.runtime import BackendRpcClient, ConnectorConfig


class FakeAdapter:
    notification_sink = None
    attachment_downloader = None

    def __init__(self) -> None:
        self.stopped = False

    async def stop(self) -> None:
        self.stopped = True

    async def model_catalog(self, *, revision: int) -> dict[str, Any]:
        return {"runtime": "fake", "revision": revision, "models": []}

    async def permission_catalog(self, *, revision: int) -> dict[str, Any]:
        return {"runtime": "fake", "revision": revision, "permissions": []}


class FakeProvider:
    runtime_id = "fake"
    runtime_type = "fake"
    display_name = "Fake Runtime"

    def __init__(self) -> None:
        self.created: list[EffectiveRuntimeConfig] = []
        self.stopped: list[Adapter] = []
        self.discoveries = 0

    async def discover(self, *, status: str) -> dict[str, Any]:
        self.discoveries += 1
        return {
            "runtimeId": self.runtime_id,
            "runtimeType": self.runtime_type,
            "displayName": self.display_name,
            "discovery": {"available": True},
            "schema": {"type": "object", "additionalProperties": False},
            "uiSchema": {},
            "status": status,
        }

    def unavailable_inventory(self, *, status: str, error: BaseException) -> dict[str, Any]:
        raise AssertionError(f"unexpected discovery error: {error}")

    async def validate_config(self, config: dict[str, Any]) -> EffectiveRuntimeConfig:
        if config.get("invalid"):
            raise RuntimeConfigError("invalid fake config")
        return EffectiveRuntimeConfig(
            target=launch_target("configured", "/tmp/fake"),
            environment={"FAKE_VALUE": str(config.get("value", "default"))},
        )

    async def create_adapter(self, effective: EffectiveRuntimeConfig) -> Adapter:
        self.created.append(effective)
        return FakeAdapter()  # type: ignore[return-value]

    async def stop_adapter(self, adapter: Adapter) -> None:
        self.stopped.append(adapter)
        await adapter.stop()  # type: ignore[attr-defined]

    def capability_specs(self) -> list[tuple[str, dict[str, Any]]]:
        return [("session.interrupt", {})]


class FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def send(self, payload: str) -> None:
        self.messages.append(json.loads(payload))


def test_supervisor_discovers_without_starting_runtime() -> None:
    asyncio.run(_test_supervisor_discovers_without_starting_runtime())


async def _test_supervisor_discovers_without_starting_runtime() -> None:
    provider = FakeProvider()
    statuses: list[tuple[str, str, dict[str, Any] | None]] = []
    changed: list[tuple[str, Adapter | None]] = []
    supervisor = RuntimeSupervisor(
        [provider],
        status_sink=lambda runtime, status, error: _append(statuses, (runtime, status, error)),
        changed_sink=lambda runtime, adapter: _append(changed, (runtime, adapter)),
    )

    inventory = await supervisor.discover()

    assert inventory["runtimes"][0]["status"] == "stopped"
    assert provider.discoveries == 1
    assert provider.created == []
    assert statuses == []
    assert changed == []
    with pytest.raises(RuntimeInactiveError):
        supervisor.resolve_adapter("fake")


def test_supervisor_start_stop_and_config_change_are_serialized() -> None:
    asyncio.run(_test_supervisor_start_stop_and_config_change_are_serialized())


async def _test_supervisor_start_stop_and_config_change_are_serialized() -> None:
    provider = FakeProvider()
    statuses: list[str] = []
    changed: list[Adapter | None] = []
    supervisor = RuntimeSupervisor(
        [provider],
        status_sink=lambda _runtime, status, _error: _append(statuses, status),
        changed_sink=lambda _runtime, adapter: _append(changed, adapter),
    )

    await supervisor.start("fake", {})
    first = supervisor.resolve_adapter("fake")
    await supervisor.start("fake", {})
    assert supervisor.resolve_adapter("fake") is first
    assert len(provider.created) == 1

    await supervisor.start("fake", {"value": "changed"})
    second = supervisor.resolve_adapter("fake")
    assert second is not first
    assert len(provider.created) == 2
    assert provider.stopped == [first]

    await supervisor.stop("fake")
    with pytest.raises(RuntimeInactiveError):
        supervisor.resolve_adapter("fake")
    assert provider.stopped == [first, second]
    assert statuses == [
        "starting",
        "running",
        "stopping",
        "stopped",
        "starting",
        "running",
        "stopping",
        "stopped",
    ]
    assert changed == [first, None, second, None]


def test_backend_dispatches_runtime_lifecycle_protocol() -> None:
    asyncio.run(_test_backend_dispatches_runtime_lifecycle_protocol())


async def _test_backend_dispatches_runtime_lifecycle_protocol() -> None:
    provider = FakeProvider()
    client = BackendRpcClient(
        ConnectorConfig(
            server_url="http://127.0.0.1:8000",
            connector_id="conn_1",
            connector_token="token",
            sync_existing_on_connect=False,
        ),
        adapters={},
        runtime_providers=[provider],
    )
    websocket = FakeWebSocket()
    client._ws = websocket  # type: ignore[assignment]

    inventory = await client.dispatch("runtime.discover", {})
    validated = await client.dispatch(
        "runtime.validateConfig",
        {"runtimeId": "fake", "config": {}},
    )
    started = await client.dispatch(
        "runtime.start",
        {"runtimeId": "fake", "config": {}},
    )
    stopped = await client.dispatch(
        "runtime.stop",
        {"runtimeId": "fake", "reason": "server_requested"},
    )

    assert inventory["runtimes"][0]["runtimeId"] == "fake"
    assert validated == {"runtimeId": "fake", "valid": True}
    assert started == {"runtimeId": "fake", "status": "running"}
    assert stopped == {"runtimeId": "fake", "status": "stopped"}
    status_events = [
        message["params"]["status"]
        for message in websocket.messages
        if message.get("method") == "runtime.statusChanged"
    ]
    assert status_events == ["starting", "running", "stopping", "stopped"]


def test_codex_provider_uses_dynamic_default_and_environment_overrides(monkeypatch) -> None:
    asyncio.run(_test_codex_provider_uses_dynamic_default_and_environment_overrides(monkeypatch))


async def _test_codex_provider_uses_dynamic_default_and_environment_overrides(monkeypatch) -> None:
    target = launch_target("cli", "/opt/codex")

    async def discover():
        return (
            {
                "execution": "ok",
                "selected": {"source": "cli", "path": target.path, "version": "codex 1"},
                "checked": [],
            },
            target,
        )

    checked: list[tuple[str, dict[str, str]]] = []

    async def check(candidate, *, environment=None):  # type: ignore[no-untyped-def]
        checked.append((candidate.path, dict(environment or {})))
        return {"status": "ok", "path": candidate.path}

    monkeypatch.setattr("connector.runtime_lifecycle.discover_codex_capability", discover)
    monkeypatch.setattr("connector.runtime_lifecycle.check_codex_target", check)
    monkeypatch.setenv("INHERITED_VALUE", "keep")
    monkeypatch.setenv("REMOVE_VALUE", "remove")

    provider = CodexRuntimeProvider(_bindings())
    inventory = await provider.discover(status="stopped")
    assert inventory["schema"]["properties"]["executablePath"]["default"] == "/opt/codex"
    assert "required" not in inventory["schema"]

    effective = await provider.validate_config(
        {
            "environment": {
                "NEW_VALUE": "new",
                "REMOVE_VALUE": None,
            }
        }
    )

    assert effective.target.path == "/opt/codex"
    assert effective.environment["INHERITED_VALUE"] == "keep"
    assert effective.environment["NEW_VALUE"] == "new"
    assert "REMOVE_VALUE" not in effective.environment
    assert checked[-1][0] == "/opt/codex"


def test_runtime_environment_rejects_connector_credentials(monkeypatch) -> None:
    asyncio.run(_test_runtime_environment_rejects_connector_credentials(monkeypatch))


async def _test_runtime_environment_rejects_connector_credentials(monkeypatch) -> None:
    target = launch_target("cli", "/opt/codex")

    async def discover():
        return ({"execution": "ok", "selected": {"path": target.path}}, target)

    monkeypatch.setattr("connector.runtime_lifecycle.discover_codex_capability", discover)
    provider = CodexRuntimeProvider(_bindings())
    await provider.discover(status="stopped")

    with pytest.raises(RuntimeConfigError, match="managed by the connector"):
        await provider.validate_config(
            {"environment": {"AGENT_CONNECTOR_TOKEN": "do-not-forward"}}
        )


def _bindings() -> RuntimeBindings:
    async def notify(_method: str, _params: dict[str, Any]) -> None:
        return None

    async def download(_session_id: str, _file_id: str) -> tuple[bytes, str, str]:
        return b"", "", ""

    return RuntimeBindings(
        notification_sink=notify,
        attachment_downloader=download,
        sync_state_store=None,
    )


async def _append(target: list[Any], value: Any) -> None:
    target.append(value)
