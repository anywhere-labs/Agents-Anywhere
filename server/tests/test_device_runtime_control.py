"""Runtime Control 3.0 for v3 devices: desired state as ``runtime.apply`` / ``channel.switch`` /
``device.settings.apply`` commands, the device's facts from ``runtime.status`` (contracts/runtime-control/3.0).

``tests/fixtures/runtime_control_commands.json`` is shared with
``connector-ts/test/entry/runtime-control.test.ts``:

- ``requests.*`` are what this Server builds; the device test feeds them to the real device handlers.
- ``results.*`` / ``deviceReports.*`` are what the real device code answers and reports; fed here to
  ``DeviceRuntimeService``.

Regenerate the Server side with ``UPDATE_RUNTIME_CONTROL_FIXTURE=1 uv run pytest -q
tests/test_device_runtime_control.py`` and review the diff.
"""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
import pytest

from agent_server.core.auth import create_user_access_token
from agent_server.core.device_meshcall import (
    COMMAND_PAYLOADS,
    DesiredState,
    RuntimeStatusEvent,
)
from agent_server.core.device_runtime import RuntimeTypeDescriptor
from agent_server.core.device_settings import ConnectorDeviceSettingsPatch
from agent_server.infra.connector_rpc import ConnectorRpcError
from agent_server.services.connector_device_settings import update_device_settings
from agent_server.services.device_commands import (
    CommandOutcome,
    DeviceCommandOffline,
    DeviceCommandRejected,
)
from agent_server.services.device_runtimes import (
    DeviceRuntimeConflictError,
    DeviceRuntimeInvalidConfigError,
    DeviceRuntimeService,
    device_runtime_entry,
)
from agent_server.services.runtime_workflows import (
    RuntimeWorkflowService,
    WorkflowError,
)

FIXTURE = Path(__file__).parent / "fixtures" / "runtime_control_commands.json"
UPDATE = os.environ.get("UPDATE_RUNTIME_CONTROL_FIXTURE") == "1"
GATEWAY = {"baseUrl": "https://gateway.example/v1", "apiKey": "sk-fixture"}
CONFIG = {"claudeExecutable": "/opt/claude/bin/claude", "modelGateway": GATEWAY}


def _fixture() -> dict[str, Any]:
    return json.loads(FIXTURE.read_text())


def _request(name: str, payload: dict[str, Any]) -> None:
    """The payload as the fixture keeps it: the instance id and revision vary per run."""

    assert isinstance(payload.get("revision", 0), int)
    kept = {**payload, "runtimeId": "rti_fixture", "revision": 0} if "runtimeId" in payload else payload
    if UPDATE:
        data = _fixture()
        data.setdefault("requests", {})[name] = kept
        FIXTURE.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
        return
    assert kept == _fixture()["requests"][name], f"Server payload {name} drifted from {FIXTURE}"


class FakeManager:
    """The v2 RPC manager: only presence matters for a v3 device; any v2 RPC is a bug here."""

    def __init__(self) -> None:
        self.online = True

    async def is_online(self, _connector_id: str) -> bool:
        return self.online

    async def request(self, *_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("a v3 device must not get v2 runtime RPCs")

    async def set_runtime_ingress_enabled(self, *_args: Any) -> None:
        raise AssertionError("v2 ingress switch used for a v3 device")


class FakeCommands:
    """``DeviceCommandService.send`` with the device's recorded answers (``results.*``)."""

    def __init__(self) -> None:
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.answer: Any = None

    async def send(self, *, user_id, device_id, kind, command_id, payload, **_kwargs) -> CommandOutcome:
        self.sent.append((kind, payload))
        answer = self.answer(kind, payload) if callable(self.answer) else self.answer
        if isinstance(answer, Exception):
            raise answer
        return CommandOutcome(command_id=command_id, result=answer or {}, replayed=False)


@asynccontextmanager
async def v3_device() -> AsyncIterator[tuple[Any, str, str, DeviceRuntimeService, FakeManager, FakeCommands]]:
    from agent_server.app import create_app

    app = create_app()
    async with (
        app.router.lifespan_context(app),
        httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://server") as client,
    ):
        user = await app.state.store.create_user(user_id="user_rc", password="password-rc")
        headers = {"Authorization": f"Bearer {create_user_access_token(user.userId)}"}
        created = await client.post("/api/v2/connectors", headers=headers, json={"name": "laptop"})
        created.raise_for_status()
        device_id = created.json()["connector"]["id"]
        await app.state.store.set_connector_link_contract(device_id, "device-meshcall/1.0")
        manager, commands = FakeManager(), FakeCommands()
        service = DeviceRuntimeService(app.state.store, manager)
        service.device_commands = commands
        # The device's own descriptor report (``runtime.types`` on Link/attach).
        await service.on_device_event(device_id, "runtime.status", _fixture()["deviceReports"]["runtimeTypes"])
        yield app, user.userId, device_id, service, manager, commands


def test_device_runtime_types_report_replaces_discovery() -> None:
    async def scenario() -> None:
        async with v3_device() as (_app, user_id, device_id, service, _manager, commands):
            types = {item.runtimeType: item for item in await service.list_runtime_types(device_id, user_id=user_id)}
            claude = types["claude"]
            assert claude.available and claude.modelConnection and claude.modelConnection["configField"] == "modelGateway"
            assert "modelGateway" in claude.schema_["properties"]
            assert await service.connector_supports(device_id, "channelReconcileFence")
            # Discovery asks nothing of a v3 device.
            await service.discover_runtime_types(device_id, user_id=user_id)
            assert commands.sent == []
            # A malformed report changes nothing.
            assert not await service.ingest_device_runtime_types(device_id, {"runtimeTypes": [{"runtimeType": "x"}]})

    asyncio.run(scenario())


def test_runtime_apply_payload_and_device_answer() -> None:
    async def scenario() -> None:
        fixture = _fixture()
        async with v3_device() as (_app, user_id, device_id, service, _manager, commands):
            results = fixture.get("results", {})
            commands.answer = lambda kind, payload: {**results.get("runtimeApply", {}), "runtimeId": payload["runtimeId"]}
            runtime = await service.create_runtime(
                device_id, runtime_type="claude", name="Work", config=CONFIG, active=True, user_id=user_id
            )
            kind, payload = commands.sent[-1]
            assert kind == "runtime.apply"
            _request("runtimeApply", payload)
            # The gateway leaves config and travels as modelGateway with the key as authToken.
            assert payload["modelGateway"] == {"baseUrl": GATEWAY["baseUrl"], "authToken": "sk-fixture", "protocol": "anthropic"}
            assert "modelGateway" not in payload["config"]
            if not UPDATE:
                assert runtime.status == "running" and runtime.active
                assert runtime.modelConnectionReport and runtime.modelConnectionReport["state"] == "applied"
                assert (await service.runtime_capabilities(device_id, runtime.runtimeId))["revision"] >= 0
            # No separate validation call, no v2 RPC (FakeManager would raise).
            assert [kind for kind, _ in commands.sent] == ["runtime.apply"]

            commands.answer = lambda kind, payload: {**results.get("runtimeApplyStop", {}), "runtimeId": payload["runtimeId"]}
            stopped = await service.set_active(device_id, runtime.runtimeId, False, user_id=user_id)
            _request("runtimeApplyStop", commands.sent[-1][1])
            assert stopped.status == "stopped" and not stopped.active

    asyncio.run(scenario())


def test_offline_device_keeps_desired_state_for_the_welcome() -> None:
    async def scenario() -> None:
        async with v3_device() as (_app, user_id, device_id, service, manager, commands):
            manager.online = False
            commands.answer = DeviceCommandOffline()
            runtime = await service.create_runtime(
                device_id, runtime_type="claude", name="Work", config=CONFIG, active=True, user_id=user_id
            )
            # Stored, not failed: it reaches the device in LinkWelcome.desired.
            assert runtime.active and runtime.status == "unknown"
            assert runtime.phase and runtime.phase["code"] == "waiting_for_device"
            updated = await service.put_config(
                device_id, runtime.runtimeId, {**CONFIG, "claudeExecutable": "/usr/bin/claude"}, user_id=user_id
            )
            assert updated.config["claudeExecutable"] == "/usr/bin/claude"
            stopped = await service.set_active(device_id, runtime.runtimeId, False, user_id=user_id)
            assert stopped.status == "stopped"
            # What the welcome would carry for it.
            entry = device_runtime_entry(stopped)
            assert entry["active"] is False and entry["config"] == {"claudeExecutable": "/usr/bin/claude"}

    asyncio.run(scenario())


def test_rejections_map_to_client_errors() -> None:
    async def scenario() -> None:
        async with v3_device() as (_app, user_id, device_id, service, _manager, commands):
            commands.answer = DeviceCommandRejected("invalid_config", "command 不是可配置项", None)
            with pytest.raises(DeviceRuntimeInvalidConfigError):
                await service.create_runtime(
                    device_id, runtime_type="claude", name="Work", config=CONFIG, active=True, user_id=user_id
                )
            runtime = (await service.list_runtimes(device_id, user_id=user_id))[0]
            assert runtime.status == "error" and runtime.error["code"] == "invalid_config"

    asyncio.run(scenario())


def test_channel_switch_carries_the_fence() -> None:
    async def scenario() -> None:
        fixture = _fixture()
        async with v3_device() as (app, user_id, device_id, service, _manager, commands):
            commands.answer = lambda kind, payload: {**fixture.get("results", {}).get("runtimeApply", {}), "runtimeId": payload["runtimeId"]}
            runtime = await service.create_runtime(
                device_id, runtime_type="claude", name="Work", config=CONFIG, active=True, user_id=user_id
            )
            fence = {"operationId": "op_switch_1", "switchRevision": 3}

            async def fenced(handle):
                async def no_execution_check() -> None:
                    return None

                app.state.store.assert_channel_execution = no_execution_check
                return await handle.put_config(CONFIG, restart=True, fence=fence)

            async with service.locked_runtime(device_id, runtime.runtimeId, user_id=user_id) as handle:
                await fenced(handle)
                kind, payload = commands.sent[-1]
                assert kind == "channel.switch"
                _request("channelSwitch", payload)
                if not UPDATE:
                    # What a switch verifies: the device ran the digest of what it was sent.
                    assert handle.last_start.get("configDigest")
                    commands.answer = DeviceCommandRejected("switch_revision_stale", "older switch", None)
                    with pytest.raises(DeviceRuntimeConflictError):
                        await handle.put_config(CONFIG, restart=True, fence=fence)

    asyncio.run(scenario())


def test_runtime_status_events_are_stored() -> None:
    async def scenario() -> None:
        fixture = _fixture()
        async with v3_device() as (_app, user_id, device_id, service, _manager, commands):
            commands.answer = lambda kind, payload: {**fixture.get("results", {}).get("runtimeApply", {}), "runtimeId": payload["runtimeId"]}
            runtime = await service.create_runtime(
                device_id, runtime_type="claude", name="Work", config=CONFIG, active=True, user_id=user_id
            )
            error = {"code": "runtime_crashed", "message": "exited"}
            await service.on_device_event(
                device_id, "runtime.status",
                {"runtimeId": runtime.runtimeId, "status": {"instance": {"status": "error", "error": error}}},
            )
            assert (await service.get_runtime(device_id, runtime.runtimeId, user_id=user_id)).error == error
            await service.on_device_event(device_id, "runtime.status", {"runtimeId": runtime.runtimeId, "status": {"state": "ready"}})
            assert (await service.get_runtime(device_id, runtime.runtimeId, user_id=user_id)).status == "running"
            capabilities = {"revision": 2, "capabilities": [{"capabilityId": "runtime.workspace.prepare", "supported": False}]}
            await service.on_device_event(
                device_id, "runtime.status",
                {"runtimeId": runtime.runtimeId, "status": {"event": "capabilities.changed"}, "capabilities": capabilities},
            )
            assert await service.runtime_capabilities(device_id, runtime.runtimeId) == capabilities
            # An instance the user stopped stays stopped whatever the device's default is.
            commands.answer = {"runtimeId": runtime.runtimeId, "status": "stopped"}
            await service.set_active(device_id, runtime.runtimeId, False, user_id=user_id)
            await service.on_device_event(
                device_id, "runtime.status", {"runtimeId": runtime.runtimeId, "status": {"instance": {"status": "running"}}}
            )
            assert (await service.get_runtime(device_id, runtime.runtimeId, user_id=user_id)).status == "stopped"

    asyncio.run(scenario())


def test_device_settings_apply_command() -> None:
    async def scenario() -> None:
        fixture = _fixture()
        async with v3_device() as (app, user_id, device_id, _service, _manager, commands):
            commands.answer = fixture.get("results", {}).get("deviceSettingsApply", {"applied": True})
            requester = type("Manager", (), {"device_commands": commands})()
            settings, delivered = await update_device_settings(
                app.state.store, requester, device_id,
                ConnectorDeviceSettingsPatch(confirmQuitOnShutdown=True), user_id=user_id,
            )
            kind, payload = commands.sent[-1]
            assert kind == "device.settings.apply"
            _request("deviceSettingsApply", payload)
            assert settings.confirmQuitOnShutdown and delivered
            # Offline: stored (LinkWelcome.desired.deviceSettings), not delivered.
            commands.answer = DeviceCommandOffline()
            _settings, delivered = await update_device_settings(
                app.state.store, requester, device_id,
                ConnectorDeviceSettingsPatch(confirmQuitOnShutdown=False), user_id=user_id,
            )
            assert not delivered
            assert (await app.state.store.get_connector_device_settings(device_id))["confirmQuitOnShutdown"] is False

    asyncio.run(scenario())


def test_workflows_on_a_v3_device_answer_definitely() -> None:
    async def scenario() -> None:
        fixture = _fixture()
        async with v3_device() as (app, user_id, device_id, service, _manager, commands):
            commands.answer = lambda kind, payload: {**fixture.get("results", {}).get("runtimeApply", {}), "runtimeId": payload["runtimeId"]}
            runtime = await service.create_runtime(
                device_id, runtime_type="claude", name="Work", config=CONFIG, active=True, user_id=user_id
            )

            class UnsupportedRpc:
                async def request(self, *_args: Any, **_kwargs: Any) -> Any:
                    raise ConnectorRpcError("device_method_unsupported", "not on v3 devices")

            workflows = RuntimeWorkflowService(app.state.store, UnsupportedRpc(), service)
            project = await app.state.store.create_project(
                user_id=user_id, connector_id=device_id, name="repo", workspace_path="/repo"
            )
            from agent_server.core.runtime_workflows import PrepareWorkspaceRequest

            with pytest.raises(WorkflowError) as prepare:
                await workflows.prepare(
                    PrepareWorkspaceRequest(
                        connectorId=device_id, runtimeId=runtime.runtimeId, projectId=project.id,
                        clientPreparationId="prep_1",
                    ),
                    user_id=user_id,
                )
            # The device reported no ``runtime.workspace.prepare``: clients create the session directly.
            assert prepare.value.code == "workflow_unsupported" and prepare.value.status == 422
            row = {"connector_id": device_id, "runtime_id": runtime.runtimeId, "runtime_type": "claude", "user_id": user_id}
            with pytest.raises(WorkflowError) as call:
                await workflows._call(row, "session.tree", {"sessionId": "sess_1"})
            assert call.value.code == "workflow_unsupported" and call.value.status == 409

    asyncio.run(scenario())


# Fixture entry -> its device-meshcall model; the Connector validates the same entries against the generated
# JSON Schemas (``connector-ts/test/entry/runtime-control.test.ts``).
RUNTIME_CONTROL_MODELS: dict[str, type[Any]] = {
    "requests.runtimeApply": COMMAND_PAYLOADS["runtime.apply"].request,
    "requests.runtimeApplyStop": COMMAND_PAYLOADS["runtime.apply"].request,
    "requests.channelSwitch": COMMAND_PAYLOADS["channel.switch"].request,
    "requests.deviceSettingsApply": COMMAND_PAYLOADS["device.settings.apply"].request,
    "results.runtimeApply": COMMAND_PAYLOADS["runtime.apply"].response,
    "results.runtimeApplyStop": COMMAND_PAYLOADS["runtime.apply"].response,
    "results.channelSwitch": COMMAND_PAYLOADS["channel.switch"].response,
    "results.deviceSettingsApply": COMMAND_PAYLOADS["device.settings.apply"].response,
    "deviceReports.claudeDescriptor": RuntimeTypeDescriptor,
    "deviceReports.runtimeTypes": RuntimeStatusEvent,
}


def test_every_fixture_entry_is_its_contract_model() -> None:
    data = _fixture()
    names = {f"{kind}.{name}" for kind, entries in data.items() for name in entries}
    assert names == set(RUNTIME_CONTROL_MODELS), "every fixture entry needs its contract model"
    for name, model in RUNTIME_CONTROL_MODELS.items():
        kind, key = name.split(".", 1)
        model.model_validate(data[kind][key])


def test_desired_runtimes_keep_the_command_shape() -> None:
    """``LinkWelcome.desired.runtimes`` items are ``RuntimeApplyCommand``s and leave absent options out."""

    request = _fixture()["requests"]["runtimeApply"]
    without_gateway = {key: value for key, value in request.items() if key != "modelGateway"}
    for payload in (request, without_gateway):
        assert DesiredState(runtimes=[payload]).model_dump(mode="json")["runtimes"] == [payload]
