"""New sessions on v3 devices: ``create-and-start`` through ``Client/call`` with a receipt (real Router, fake device)."""

from __future__ import annotations

import asyncio
import base64
from typing import Any

from device_link_helpers import eventually, offline, server, user_and_device
from mesh_fixtures import RouterProcess

from agent_server.core.device_meshcall import LinkError
from scripts.v3_fake_device import connect_device


def test_create_and_start_runs_on_the_device_once(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            store = app.state.store
            headers, device_id, token = await user_and_device(app, client)
            project_id = (await client.get("/api/v2/projects", headers=headers)).json()["projects"][0]["id"]
            device, _welcome, access = await connect_device(client, connector_id=device_id, connector_token=token)
            state = device.state

            def handle(request: dict[str, Any]) -> Any:
                if request["body"]["content"] == "refuse":
                    return LinkError(code="runtime_unavailable", message="codex is not installed")
                return 200, {"connectorResult": {"created": True, "messageAccepted": True}}

            state.client_handler = handle

            def body(content: str, message_id: str, **extra: Any) -> dict[str, Any]:
                return {
                    "connectorId": device_id,
                    "projectId": project_id,
                    "runtime": "codex",
                    "content": content,
                    "clientMessageId": message_id,
                    **extra,
                }

            async def listed() -> list[str]:
                return [item["id"] for item in (await client.get("/api/v2/sessions", headers=headers)).json()["sessions"]]

            try:
                attachment = {
                    "fileId": "inline_1",
                    "name": "a.txt",
                    "mediaType": "text/plain",
                    "contentBase64": base64.b64encode(b"hello").decode(),
                }
                first = body("fix the build", "m_create_1", title="Build", attachments=[attachment])
                started = await client.post("/api/v2/sessions/create-and-start", headers=headers, json=first)
                assert started.status_code == 200, started.text
                session_id = started.json()["session"]["id"]
                assert started.json()["connectorResult"] == {"created": True, "messageAccepted": True}
                request = state.client_calls[-1]
                assert request["route"] == "session.createAndStart" and request["method"] == "POST"
                assert request["path"] == "/api/v2/sessions/create-and-start"
                assert request["command"]["commandId"] == "m_create_1"
                # The Server's facts: the session id it allocated, takeover, and the staged attachments.
                facts = request["server"]
                assert facts["sessionId"] == session_id and facts["takeover"] is True
                [sent] = facts["attachments"]
                assert sent["name"] == "a.txt" and sent["size"] == 5 and sent["fileId"].startswith("file_")
                assert "attachments" not in request["body"]
                assert request["body"]["content"] == "fix the build" and request["body"]["cwd"] == "/repo"
                assert [item["fileId"] for item in started.json()["attachments"]] == [sent["fileId"]]
                receipt = await store.get_device_command("user_v3", "m_create_1")
                assert (receipt["kind"], receipt["state"], receipt["sessionId"]) == (
                    "session.createAndStart", "accepted", session_id
                )
                # The device fetches the staged file from the Server.
                fetched = await client.get(
                    f"/api/v3/device/attachments/{sent['fileId']}",
                    params={"sessionId": session_id},
                    headers={"Authorization": f"Bearer {access}"},
                )
                assert fetched.status_code == 200 and fetched.content == b"hello"

                # A retry returns the same session; the device's inbox answers, nothing runs twice.
                runs = len(state.client_runs)
                again = await client.post("/api/v2/sessions/create-and-start", headers=headers, json=first)
                assert again.status_code == 200, again.text
                assert again.json()["session"]["id"] == session_id
                assert len(state.client_runs) == runs
                assert state.client_calls[-1]["server"]["sessionId"] == session_id
                assert await listed() == [session_id]

                # The same id with another request is a conflict, not a second session.
                conflict = await client.post(
                    "/api/v2/sessions/create-and-start", headers=headers, json=body("other", "m_create_1")
                )
                assert conflict.status_code == 409 and conflict.json()["detail"]["code"] == "command_conflict"
                assert await listed() == [session_id]

                # Refused by the device: its error, and no directory row is left behind.
                refused = await client.post(
                    "/api/v2/sessions/create-and-start", headers=headers, json=body("refuse", "m_create_2")
                )
                assert refused.status_code == 409
                assert refused.json()["detail"]["code"] == "runtime_unavailable"
                assert await listed() == [session_id]
            finally:
                await device.stop()

            await eventually(lambda: offline(app.state.connector_presence, device_id))
            calls = len(state.client_calls)
            down = await client.post(
                "/api/v2/sessions/create-and-start", headers=headers, json=body("later", "m_create_3")
            )
            assert down.status_code == 409 and down.json()["detail"]["code"] == "connector_offline"
            assert await listed() == [session_id]
            assert await store.get_device_command("user_v3", "m_create_3") is None
            assert len(state.client_calls) == calls

    asyncio.run(scenario())
