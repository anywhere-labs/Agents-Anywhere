"""The Server against what a real v3 device sends and answers.

``tests/fixtures/device_shapes.json`` is shared with ``connector-ts/test/application/server-shapes.test.ts``:

- ``requests.*`` are the command payloads the device's inbox takes (from the Server, or from a client through
  ``Client/call``); the tests here check the Server still sends its own, the Connector test feeds them all to
  the real command inbox.
- every other entry is what the real Connector code answers or emits; the Connector test checks it still
  produces them exactly, the tests here feed them to the Server (through the fake device or a service).
- every entry is also checked against its device-meshcall model (``SHAPE_MODELS``) here and against the
  generated JSON Schema on the Connector side.

The fake device elsewhere answers what the Server expects; these tests use what the device really says.
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from device_link_helpers import (
    acked,
    eventually,
    offline,
    server,
    summary,
    user_and_device,
)
from mesh_fixtures import RouterProcess

from agent_server.core.device_meshcall import (
    COMMAND_PAYLOADS,
    READ_PAYLOADS,
    RuntimeStatusEvent,
)
from agent_server.core.goal.models import GoalState
from agent_server.core.planning.models import PlanDocument, PlanningState
from agent_server.core.protocol import ProtocolCapabilitySet
from agent_server.core.runtime_workflows import (
    BeginCreationRequest,
    PrepareWorkspaceRequest,
)
from agent_server.services.device_link import DeviceLinkService
from agent_server.services.runtime_workflows import RuntimeWorkflowService
from scripts.v3_fake_device import connect_device

SHAPES: dict[str, Any] = json.loads((Path(__file__).parent / "fixtures" / "device_shapes.json").read_text())
REQUESTS: dict[str, dict[str, Any]] = SHAPES["requests"]
SID = "sess_shape"


# -- 1. planning and goal events -----------------------------------------------------------------------


def test_planning_and_goal_events_of_a_real_device_reach_subscribers() -> None:
    published: list[tuple[str, dict[str, Any]]] = []

    class Broker:
        async def publish(self, session_id: str, message: dict[str, Any]) -> None:
            published.append((session_id, message))

    async def scenario() -> None:
        service = DeviceLinkService(None, None, SimpleNamespace(), None, Broker())  # type: ignore[arg-type]
        await service.handle_event("conn_shape", "runtime.status", SHAPES["event.planning"])
        await service.handle_event("conn_shape", "runtime.status", SHAPES["event.goal"])
        [(planning_sid, planning), (goal_sid, goal)] = published
        assert planning_sid == goal_sid == SID
        assert planning["planningState"] == SHAPES["event.planning"]["status"]["state"]
        PlanningState.model_validate(planning["planningState"])
        assert goal["goalState"] == SHAPES["event.goal"]["status"]["state"]
        GoalState.model_validate(goal["goalState"])

    asyncio.run(scenario())


# -- 2. takeover -------------------------------------------------------------------------------------


def test_takeover_reaches_the_device_now_or_when_it_links_again(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            base = f"/api/v2/sessions/{SID}"
            try:
                pushed = device.state.push_outbox("session.summary", summary(SID, 0))
                await eventually(lambda: acked(device, pushed.oid))
                assert (await client.post(f"{base}/takeover", headers=headers)).status_code == 200
                assert ("session.sync", {"sessionId": SID, "takeover": True}) in device.state.command_log
                assert await app.state.device_link.pending_takeover(device_id) == {}
            finally:
                await device.stop()
            await eventually(lambda: offline(app.state.rpc, device_id))

            # Offline: the Server keeps the change and sends it when the device links again.
            released = await client.delete(f"{base}/takeover", headers=headers)
            assert released.status_code == 200 and released.json()["session"]["takeover"] is False
            assert set(await app.state.device_link.pending_takeover(device_id)) == {SID}
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:

                async def synced() -> bool:
                    return ("session.sync", {"sessionId": SID, "takeover": False}) in device.state.command_log

                await eventually(synced)
                await eventually(lambda: _no_pending(app, device_id))
            finally:
                await device.stop()

    asyncio.run(scenario())


async def _no_pending(app: Any, device_id: str) -> bool:
    return await app.state.device_link.pending_takeover(device_id) == {}


# -- 3. source availability ----------------------------------------------------------------------------


def test_source_availability_follows_the_device_both_ways(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            _headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                for availability in ("missing", "available"):
                    body = summary(SID, 0)
                    body["summary"]["sourceAvailability"] = availability
                    pushed = device.state.push_outbox("session.summary", body)
                    await eventually(lambda pushed=pushed: acked(device, pushed.oid))
                    assert (await app.state.store.get_session(SID)).sourceAvailability == availability
            finally:
                await device.stop()

    asyncio.run(scenario())


# -- 4. workspace preparation and the creation that consumes it -----------------------------------------


class _PreparingDevice:
    """Answers the workflow commands and reads with what the real device answered (``workspacePrepare.result`` and
    the rest), as ``DeviceCommandService.send`` and ``DeviceReadService.read_method`` would."""

    def __init__(self, reserve: str = "workspacePreparationReserve.result") -> None:
        self.sent: list[tuple[str, dict[str, Any]]] = []
        self.answers = {
            "workspace.prepare": SHAPES["workspacePrepare.result"],
            "workspace.preparation.get": SHAPES["workspacePreparation.ready"],
            "workspace.preparation.reserve": SHAPES[reserve],
            "session.creation.begin": SHAPES["creationPrepared.result"],
            "session.creation.get": SHAPES["creationPrepared.accepted"],
        }

    async def send(self, *, kind: str, payload: dict[str, Any], **_ignored: Any) -> Any:
        self.sent.append((kind, payload))
        return SimpleNamespace(result=self.answers[kind])

    async def is_v3_device(self, connector_id: str) -> bool:
        return True

    async def read_method(self, device_id: str, method: str, params: dict[str, Any]) -> dict[str, Any]:
        self.sent.append((method, params))
        return self.answers[method]


class _Runtimes:
    """A running v3 instance that reported the device's preparation capabilities."""

    async def get_runtime(self, connector_id: str, runtime_id: str, *, user_id: str) -> Any:
        return SimpleNamespace(status="running", runtimeType="opencode", runtimeId=runtime_id)

    async def is_v3_device(self, connector_id: str) -> bool:
        return True

    async def runtime_capabilities(self, connector_id: str, runtime_id: str) -> dict[str, Any]:
        return SHAPES["runtime.capabilities.prepared"]


def test_a_prepared_creation_is_sent_as_the_device_reads_it(mesh_router: RouterProcess, monkeypatch) -> None:
    """prepare -> get (real catalog) -> begin (reserve, then creation.begin) -> get, against the real device answers."""

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, _token = await user_and_device(app, client)
            project_id = (await client.get("/api/v2/projects", headers=headers)).json()["projects"][0]["id"]
            device = _PreparingDevice()
            workflows = RuntimeWorkflowService(app.state.store, _Runtimes(), device, device)  # type: ignore[arg-type]
            prepare = REQUESTS["workspacePrepare"]
            opening = await workflows.prepare(
                PrepareWorkspaceRequest(
                    connectorId=device_id, runtimeId=prepare["runtimeId"], projectId=project_id,
                    clientPreparationId=prepare["clientPreparationId"],
                ),
                user_id="user_v3",
            )
            preparation_id = opening.id
            assert device.sent[-1] == (
                "workspace.prepare", {**prepare, "preparationId": preparation_id, "projectId": project_id}
            )
            assert opening.state.model_dump()["phase"] == "opening"

            ready = await workflows.get(preparation_id, "preparation", user_id="user_v3")
            assert device.sent[-1] == (
                "workspace.preparation.get",
                {"runtime": "opencode", "runtimeId": prepare["runtimeId"], "preparationId": preparation_id},
            )
            catalog = ready.state.catalog
            assert catalog is not None and [model.id for model in catalog.models] == ["m1", "m2"]
            state = ready.state.model_dump(mode="json")
            assert state["configuration"]["options"] and state["revision"] == 1

            begin = REQUESTS["creationPrepared"]
            reserve = REQUESTS["workspacePreparationReserve"]
            view = await workflows.begin(
                BeginCreationRequest(
                    preparationId=preparation_id,
                    createOperationId=begin["createOperationId"],
                    expectedRevision=reserve["expectedRevision"],
                    catalogRevision=reserve["catalogRevision"],
                    selections=begin["selections"],
                    clientMessageId=begin["clientMessageId"],
                    content=begin["content"],
                ),
                user_id="user_v3",
            )
            (reserve_method, reserve_sent), (begin_method, begin_sent) = device.sent[-2:]
            session_id = view.sessionId
            assert session_id is not None and session_id.startswith("sess_")
            assert reserve_method == "workspace.preparation.reserve"
            assert reserve_sent == {**reserve, "preparationId": preparation_id, "platformSessionId": session_id}
            assert begin_method == "session.creation.begin"
            assert begin_sent == {**begin, "preparationId": preparation_id, "sessionId": session_id}
            assert view.state.model_dump()["phase"] == "submitting"
            session = await app.state.store.get_session(session_id)
            assert session.cwd == "/repo" and session.runtime == "opencode" and session.takeover is True

            accepted = await workflows.get(begin["createOperationId"], "creation", user_id="user_v3")
            assert device.sent[-1] == (
                "session.creation.get",
                {"runtime": "opencode", "runtimeId": prepare["runtimeId"], "createOperationId": begin["createOperationId"]},
            )
            assert accepted.state.model_dump()["messageAccepted"] is True and accepted.sessionId == session_id

    asyncio.run(scenario())


def test_a_refused_reservation_rejects_the_creation_without_a_session(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, _token = await user_and_device(app, client)
            project_id = (await client.get("/api/v2/projects", headers=headers)).json()["projects"][0]["id"]
            device = _PreparingDevice(reserve="workspacePreparationReserve.stale")
            workflows = RuntimeWorkflowService(app.state.store, _Runtimes(), device, device)  # type: ignore[arg-type]
            opening = await workflows.prepare(
                PrepareWorkspaceRequest(
                    connectorId=device_id, runtimeId="rti_shape", projectId=project_id, clientPreparationId="client_stale"
                ),
                user_id="user_v3",
            )
            view = await workflows.begin(
                BeginCreationRequest(
                    preparationId=opening.id, createOperationId="op_stale", expectedRevision=1, catalogRevision=0,
                    selections={"model": "m1"}, clientMessageId="m_stale", content="hello",
                ),
                user_id="user_v3",
            )
            assert [method for method, _params in device.sent] == ["workspace.prepare", "workspace.preparation.reserve"]
            state = view.state.model_dump()
            assert state["phase"] == "rejected" and state["failure"]["code"] == "preparation_stale"
            assert view.sessionId is None

    asyncio.run(scenario())


# -- 5. every shape against its device-meshcall model --------------------------------------------------

@dataclass(frozen=True)
class _Body:
    """A client API body (``Client/call``): ``model`` is the protocol model of what it holds under ``key``."""

    model: type[Any]
    key: str
    first: bool = False

    def value(self, body: dict[str, Any]) -> Any:
        inner = body[self.key]
        return inner[0] if self.first else inner


# Fixture entry -> (method, "request" | "response") in ``COMMAND_PAYLOADS`` / ``READ_PAYLOADS``, a model, or a
# client API body.
SHAPE_MODELS: dict[str, tuple[str, str] | type[Any] | _Body] = {
    "requests.select": ("session.select", "request"),
    "requests.creationPlan": ("session.creation.begin", "request"),
    "requests.creationGoal": ("session.creation.begin", "request"),
    "requests.workspacePrepare": ("workspace.prepare", "request"),
    "requests.workspacePreparationReserve": ("workspace.preparation.reserve", "request"),
    "requests.creationPrepared": ("session.creation.begin", "request"),
    "select.result": ("session.select", "response"),
    "state.goal.unobserved": _Body(GoalState, "goal"),
    "state.planning": _Body(PlanningState, "planning"),
    "state.goal": _Body(GoalState, "goal"),
    "planning.result": ("session.planning", "response"),
    "goal.result": ("session.goal", "response"),
    "event.planning": RuntimeStatusEvent,
    "event.goal": RuntimeStatusEvent,
    "event.commands": RuntimeStatusEvent,
    "event.writer": RuntimeStatusEvent,
    "event.usage": RuntimeStatusEvent,
    "event.background": RuntimeStatusEvent,
    "event.capabilities": RuntimeStatusEvent,
    "planDocument.list": _Body(PlanDocument, "plans", first=True),
    "planDocument.one": _Body(PlanDocument, "document"),
    "runtime.capabilities.prepared": ProtocolCapabilitySet,
    "workspacePrepare.result": ("workspace.prepare", "response"),
    "workspacePreparation.ready": ("workspace.preparation.get", "response"),
    "workspacePreparationReserve.stale": ("workspace.preparation.reserve", "response"),
    "workspacePreparationReserve.result": ("workspace.preparation.reserve", "response"),
    "creationPrepared.result": ("session.creation.begin", "response"),
    "creationPrepared.accepted": ("session.creation.get", "response"),
}


def _shape(name: str) -> Any:
    if name.startswith("requests."):
        return REQUESTS[name.removeprefix("requests.")]
    return SHAPES[name]


def _validate(entry: tuple[str, str] | type[Any] | _Body, value: Any) -> None:
    if isinstance(entry, _Body):
        entry.model.model_validate(entry.value(value))
        return
    if not isinstance(entry, tuple):
        entry.model_validate(value)
        return
    method, part = entry
    payloads = COMMAND_PAYLOADS.get(method) or READ_PAYLOADS[method]
    (payloads.request if part == "request" else payloads.response).model_validate(value)


def test_every_shape_is_its_contract_model() -> None:
    """Both sides validate these entries: the Server with the pydantic models, the Connector with the generated
    JSON Schemas (``connector-ts/test/application/server-shapes.test.ts``)."""

    names = {f"requests.{key}" for key in REQUESTS} | {key for key in SHAPES if key != "requests"}
    assert names == set(SHAPE_MODELS), "every fixture entry needs its contract model"
    for name, entry in SHAPE_MODELS.items():
        _validate(entry, _shape(name))


def test_the_server_refuses_a_payload_that_breaks_the_contract() -> None:
    from pydantic import ValidationError

    from agent_server.core.device_meshcall import validate_command_payload

    validate_command_payload("session.select", REQUESTS["select"])
    try:
        validate_command_payload("session.select", {"selections": {}})
    except ValidationError:
        pass
    else:
        raise AssertionError("a select without sessionId must not reach the device")
