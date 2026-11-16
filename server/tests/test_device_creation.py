"""New sessions on v3 devices: ``session.creation.begin`` with a receipt (real Router, fake device)."""

from __future__ import annotations

import asyncio
import base64

from device_link_helpers import eventually, offline, server, user_and_device
from mesh_fixtures import RouterProcess

from agent_server.core.device_meshcall import LinkError
from scripts.v3_fake_device import connect_device


def test_create_and_start_runs_on_the_device_once(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            project_id = (await client.get("/api/v2/projects", headers=headers)).json()["projects"][0]["id"]
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)

            def handle(method: str, p: dict):
                if method == "session.creation.begin" and p["content"] == "refuse":
                    return LinkError(code="runtime_unavailable", message="codex is not installed")
                return {"created": True, "messageAccepted": True, "sessionId": p.get("sessionId")}

            device.state.command_handler = handle

            def body(content: str, message_id: str, **extra) -> dict:
                return {
                    "connectorId": device_id,
                    "projectId": project_id,
                    "runtime": "codex",
                    "content": content,
                    "clientMessageId": message_id,
                    **extra,
                }

            try:
                attachment = {
                    "fileId": "inline_1",
                    "name": "a.txt",
                    "mediaType": "text/plain",
                    "contentBase64": base64.b64encode(b"hello").decode(),
                }
                started = await client.post(
                    "/api/v2/sessions/create-and-start",
                    headers=headers,
                    json=body("fix the build", "m_create_1", title="Build", attachments=[attachment]),
                )
                assert started.status_code == 200, started.text
                session_id = started.json()["session"]["id"]
                method, payload = device.state.command_log[-1]
                assert method == "session.creation.begin"
                assert payload["sessionId"] == session_id and payload["content"] == "fix the build"
                assert payload["runtimeType"] == "codex" and payload["cwd"] == "/repo" and payload["takeover"] is True
                assert payload["title"] == "Build"
                [sent] = payload["attachments"]
                assert sent["name"] == "a.txt" and sent["size"] == 5 and sent["fileId"].startswith("file_")
                # The device fetches the staged file from the Server.
                fetched = await client.get(
                    f"/api/v3/device/attachments/{sent['fileId']}",
                    params={"sessionId": session_id},
                    headers={"Authorization": f"Bearer {_access}"},
                )
                assert fetched.status_code == 200 and fetched.content == b"hello"

                # A retry returns the same session; nothing is created or sent twice.
                calls = len(device.state.command_log)
                again = await client.post(
                    "/api/v2/sessions/create-and-start", headers=headers, json=body("fix the build", "m_create_1")
                )
                assert again.status_code == 200 and again.json()["session"]["id"] == session_id
                assert len(device.state.command_log) == calls
                listed = (await client.get("/api/v2/sessions", headers=headers)).json()["sessions"]
                assert [item["id"] for item in listed] == [session_id]

                refused = await client.post(
                    "/api/v2/sessions/create-and-start", headers=headers, json=body("refuse", "m_create_2")
                )
                assert refused.status_code == 409
                assert refused.json()["detail"]["code"] == "runtime_unavailable"
                listed = (await client.get("/api/v2/sessions", headers=headers)).json()["sessions"]
                assert [item["id"] for item in listed] == [session_id]
            finally:
                await device.stop()

            await eventually(lambda: offline(app.state.rpc, device_id))
            down = await client.post(
                "/api/v2/sessions/create-and-start", headers=headers, json=body("later", "m_create_3")
            )
            assert down.status_code == 409
            listed = (await client.get("/api/v2/sessions", headers=headers)).json()["sessions"]
            assert len(listed) == 1

    asyncio.run(scenario())
