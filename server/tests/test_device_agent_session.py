"""The Agent session behind a v3 session (``/runtime-workflows/sessions/{id}/*``) is the device's (real Router, fake
device): the configuration panel, Agent operations, the session tree, releasing and recovering it."""

from __future__ import annotations

import asyncio
from typing import Any

from device_link_helpers import acked, eventually, server, summary, user_and_device
from mesh_fixtures import RouterProcess

from scripts.v3_fake_device import connect_device

CONFIGURATION = {
    "configuration": {"revision": 7, "options": [
        {"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "m1",
         "options": [{"value": "m1", "name": "M1"}, {"value": "m2", "name": "M2"}]},
    ]},
    "ownerGeneration": "native_1",
    "actions": [],
}


def test_agent_session_routes_go_to_the_device(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            state = device.state
            base = "/api/v2/runtime-workflows/sessions/sess_a1"

            def handle(request: dict[str, Any]) -> Any:
                route, body = request["route"], request["body"] or {}
                if route == "workflow.session.configuration.get":
                    return 200, CONFIGURATION
                if route == "workflow.session.configuration.update":
                    if body["expectedRevision"] != 7:
                        return 409, {"detail": {"code": "configuration_changed", "message": "changed"}}
                    return 200, {**CONFIGURATION, "operationId": body["operationId"], "phase": "completed"}
                if route == "workflow.session.operations":
                    return 202, {"operationId": body["operationId"], "phase": "completed", "result": {"commands": []}}
                if route == "workflow.session.tree":
                    return 409, {"detail": {"code": "capability_unavailable", "message": "no tree"}}
                if route == "workflow.session.close":
                    return 200, {"closed": True}
                if route == "workflow.session.recover":
                    return 202, {"operationId": body["operationId"], "phase": "completed",
                                 "state": {"metadata": {"ownerGeneration": "native_1"}}}
                return 404, {"detail": {"code": "route_not_found", "message": route}}

            state.client_handler = handle
            pushed = state.push_outbox("session.summary", summary("sess_a1", 0))
            await eventually(lambda: acked(device, pushed.oid))
            assert (await client.post("/api/v2/sessions/sess_a1/takeover", headers=headers)).status_code == 200

            read = await client.get(f"{base}/configuration", headers=headers)
            assert read.status_code == 200, read.text
            assert read.json()["configuration"]["revision"] == 7
            assert state.client_calls[-1]["server"] == {"takeover": True, "archived": False}

            update = {"operationId": "op_cfg", "expectedRevision": 7, "values": {"model": "m2"}}
            updated = await client.post(f"{base}/configuration", headers=headers, json=update)
            assert updated.status_code == 200, updated.text
            assert updated.json()["phase"] == "completed"
            # The operation id is the command's receipt identity.
            assert state.client_calls[-1]["command"]["commandId"] == "op_cfg"
            stale = await client.post(f"{base}/configuration", headers=headers, json={**update, "operationId": "op_2",
                                                                                     "expectedRevision": 1})
            assert stale.status_code == 409 and stale.json()["detail"]["code"] == "configuration_changed"
            # The Server still checks the request model before anything reaches the device.
            calls = len(state.client_calls)
            invalid = await client.post(f"{base}/configuration", headers=headers,
                                        json={**update, "values": {"model": 1}})
            assert invalid.status_code == 422 and len(state.client_calls) == calls

            operated = await client.post(f"{base}/operations", headers=headers, json={
                "operation": "resources.get", "operationId": "op_res", "expectedGeneration": "native_1",
            })
            assert operated.status_code == 202, operated.text
            assert operated.json()["result"] == {"commands": []}

            tree = await client.get(f"{base}/tree", headers=headers)
            assert tree.status_code == 409 and tree.json()["detail"]["code"] == "capability_unavailable"

            closed = await client.post(f"{base}/close", headers=headers,
                                       json={"ownerGeneration": "native_1", "closeOperationId": "close_1"})
            assert closed.status_code == 200 and closed.json() == {"closed": True}
            assert state.client_calls[-1]["command"]["commandId"].startswith("c_")

            body = {"operationId": "op_rec", "expectedGeneration": "native_1"}
            recovered = await client.post(f"{base}/recover", headers=headers, json=body)
            assert recovered.status_code == 202, recovered.text
            assert recovered.json()["phase"] == "completed"
            assert state.client_calls[-1]["command"]["commandId"] == "op_rec"

            # Another user's session is not found and never asked.
            calls = len(state.client_calls)
            other = await client.post(f"{base.replace('sess_a1', 'sess_none')}/recover", headers=headers, json=body)
            assert other.status_code == 404 and len(state.client_calls) == calls

    asyncio.run(scenario())
