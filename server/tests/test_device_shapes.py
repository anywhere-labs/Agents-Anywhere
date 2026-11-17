"""The Server against what a real v3 device sends and answers.

``tests/fixtures/device_shapes.json`` is shared with ``connector-ts/test/application/server-shapes.test.ts``:

- ``requests.*`` are the payloads the Server sends; the tests here check the Server still sends them, the
  Connector test feeds them to the real command inbox.
- every other entry is what the real Connector code answers or emits; the Connector test checks it still
  produces them exactly, the tests here feed them to the Server (through the fake device or a service).

The fake device elsewhere answers what the Server expects; these tests use what the device really says.
"""

from __future__ import annotations

import asyncio
import json
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

from agent_server.core.goal.models import GoalState
from agent_server.core.models import SessionSelectionPatchRequest, SessionView
from agent_server.core.planning.models import PlanningState
from agent_server.infra.device_link import V2_COMMAND_METHODS, _device_payload
from agent_server.services.device_link import DeviceLinkService
from agent_server.services.session_run import SessionRunService
from scripts.v3_fake_device import connect_device

SHAPES: dict[str, Any] = json.loads((Path(__file__).parent / "fixtures" / "device_shapes.json").read_text())
REQUESTS: dict[str, dict[str, Any]] = SHAPES["requests"]
SID = "sess_shape"


def _session_view(**extra: Any) -> SessionView:
    return SessionView.model_validate(
        {
            "id": SID,
            "connectorId": "conn_shape",
            "connectorStatus": "online",
            "runtime": "codex",
            "runtimeId": "codex",
            "externalSessionId": f"thr_{SID}",
            "status": "idle",
            "takeover": True,
            "updatedSeq": 3,
            **extra,
        }
    )


# -- 1. selections -------------------------------------------------------------------------------


def test_selection_update_sends_v2_selections_and_reads_the_device_result() -> None:
    """``PATCH runtime/selections`` -> ``session.select {selections}``; the device's v2 result becomes the state."""

    sent: list[tuple[str, str, dict[str, Any]]] = []

    class Manager:
        async def is_online(self, device_id: str) -> bool:
            return True

        async def request(self, device_id: str, method: str, params: dict[str, Any], *, timeout: float) -> Any:
            sent.append((device_id, method, params))
            return SHAPES["select.result"]

    class Store:
        async def get_session(self, session_id: str, *, user_id: str | None = None) -> SessionView:
            return _session_view()

    async def scenario() -> None:
        service = SessionRunService(Store(), Manager(), SimpleNamespace())  # type: ignore[arg-type]

        async def allowed(*_args: Any, **_kwargs: Any) -> None:
            return None

        service._require_session_capability = allowed  # type: ignore[method-assign]
        service._ensure_session_runtime_running = allowed  # type: ignore[method-assign]
        selections = REQUESTS["select"]["selections"]
        state, result = await service.update_session_selections(
            SID, SessionSelectionPatchRequest(selections=selections), user_id="user_shape"
        )
        [(device_id, method, params)] = sent
        assert device_id == "conn_shape" and method == "session.selections.update"
        # What reaches the device: the bridge renames the method and passes the parameters through.
        assert V2_COMMAND_METHODS[method] == "session.select"
        assert _device_payload(method, params, "cmd_1") == REQUESTS["select"]
        assert result == SHAPES["select.result"]
        assert state.selections == SHAPES["select.result"]["state"]["selections"]
        assert state.status == "idle" and state.externalSessionId == f"thr_{SID}"

    asyncio.run(scenario())


# -- 2, 3. planning and goal state, plan documents, planning and goal commands -------------------------


def test_planning_goal_and_plans_answered_by_a_real_device(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            base = f"/api/v2/sessions/{SID}"
            try:
                pushed = device.state.push_outbox("session.summary", summary(SID, 0))
                await eventually(lambda: acked(device, pushed.oid))
                assert (await client.post(f"{base}/takeover", headers=headers)).status_code == 200
                device.state.capability_ids = ["session.planning", "session.plan_review", "session.goal"]

                # A device that has not seen a goal yet: fresh, with the actions its capabilities declare.
                device.state.state_parts[(SID, "goal")] = SHAPES["state.goal.unobserved"]
                goal = await client.get(f"{base}/goal", headers=headers)
                assert goal.status_code == 200, goal.text
                assert goal.json()["freshness"] == "fresh" and "set" in goal.json()["capabilities"]["actions"]

                device.state.state_parts[(SID, "planning")] = SHAPES["state.planning"]
                planning = await client.get(f"{base}/planning", headers=headers)
                assert planning.status_code == 200, planning.text
                expected = PlanningState.model_validate(SHAPES["state.planning"]["planning"]).model_dump(mode="json")
                assert planning.json() == expected
                assert planning.json()["freshness"] == "fresh" and planning.json()["review"]["status"] == "open"
                assert "approve_and_execute" in planning.json()["capabilities"]["actions"]

                device.state.state_parts[(SID, "goal")] = SHAPES["state.goal"]
                goal = await client.get(f"{base}/goal", headers=headers)
                assert goal.json()["goal"]["objective"] == "ship it" and goal.json()["freshness"] == "fresh"

                # Plan documents: the fake answers ``{plans}`` / ``{document}`` like the real device.
                [document] = SHAPES["planDocument.list"]["plans"]
                assert SHAPES["planDocument.one"] == {"document": document}
                device.state.plans[SID] = SHAPES["planDocument.list"]["plans"]
                listed = await client.get(f"{base}/plans", headers=headers)
                assert listed.status_code == 200 and [plan["planId"] for plan in listed.json()] == [document["planId"]]
                path = f"{base}/plans/{document['planId']}/{document['revision']}"
                markdown = await client.get(f"{path}/markdown", headers=headers)
                assert markdown.status_code == 200, markdown.text
                assert markdown.text == document["markdown"]
                missing = await client.get(f"{base}/plans/{document['planId']}/9", headers=headers)
                assert missing.status_code == 404

                def handle(method: str, p: dict) -> Any:
                    if method == "session.planning":
                        return SHAPES["planning.result"]
                    if method == "session.goal":
                        return SHAPES["goal.result"]
                    return {"ok": True}

                device.state.command_handler = handle
                applied = await client.post(
                    f"{base}/planning", headers=headers, json={"command": "enter_plan", "operationId": "op_plan_1"}
                )
                assert applied.status_code == 200, applied.text
                assert applied.json()["outcome"] == "applied" and applied.json()["ok"] is True
                assert applied.json()["state"]["effectiveMode"] == "plan"
                goal_set = await client.post(
                    f"{base}/goal",
                    headers=headers,
                    json={"operationId": "op_goal_1", "expectedRevision": 0, "action": "set", "objective": "ship it"},
                )
                assert goal_set.status_code == 200, goal_set.text
                assert goal_set.json()["outcome"] == "applied"
                assert goal_set.json()["state"]["goal"]["objective"] == "ship it"
            finally:
                await device.stop()

    asyncio.run(scenario())


# -- 4. planning and goal events -----------------------------------------------------------------------


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


# -- 5. /plan and /goal on a new session -------------------------------------------------------------


def test_creation_intents_are_sent_as_the_device_reads_them(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            project_id = (await client.get("/api/v2/projects", headers=headers)).json()["projects"][0]["id"]
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                for content, key in (("/plan design the cache", "creationPlan"), ("/goal ship the release", "creationGoal")):
                    expected = REQUESTS[key]
                    started = await client.post(
                        "/api/v2/sessions/create-and-start",
                        headers=headers,
                        json={
                            "connectorId": device_id,
                            "projectId": project_id,
                            "runtime": "codex",
                            "content": content,
                            "clientMessageId": expected["clientMessageId"],
                        },
                    )
                    assert started.status_code == 200, started.text
                    method, payload = device.state.command_log[-1]
                    assert method == "session.creation.begin"
                    assert payload == {**expected, "sessionId": started.json()["session"]["id"]}
            finally:
                await device.stop()

    asyncio.run(scenario())


# -- 6. takeover -------------------------------------------------------------------------------------


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


# -- 7. source availability ----------------------------------------------------------------------------


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
