"""E2EE ``required`` mode on the device link (F's handover list, ``contracts/e2ee/1.0``).

- The device token and the fake device follow the per-mode registration table.
- A plaintext display envelope a device still sends is dropped, a sealed one is stored.
- Outbox ``command.result`` settles encrypted command registrations; receipts keep no result body.
"""

from __future__ import annotations

import asyncio

from device_link_helpers import acked, eventually, server, summary, user_and_device
from mesh_fixtures import RouterProcess

from agent_server.core.device_meshcall import DisplayEnvelope, registered_services
from agent_server.core.e2ee_settings import E2eeSettings
from scripts.v3_fake_device import connect_device

DIGEST = "hmac-sha256:" + "A" * 43


def test_required_mode_device_link_stores_no_plaintext(mesh_router: RouterProcess, monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SERVER_E2EE", "required")

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            store = app.state.store
            device, welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                assert welcome["e2eeMode"] == "required"
                registered = await app.state.device_mesh.registered_services(device_id)
                assert registered == set(registered_services("required"))

                # The directory row exists (placement by a sealed summary is F's open design item).
                await store.upsert_connector_session(
                    connector_id=device_id, session_id="sess_h1", runtime="codex", runtime_id="codex",
                    external_session_id="thr_sess_h1", title=None, cwd="/repo", last_activity_at=None,
                )

                # A plaintext envelope is dropped: no envelope, no title, no working directory.
                plain = device.state.push_outbox("session.summary", summary("sess_h1", 2, title="plain secret"))
                await eventually(lambda: acked(device, plain.oid))
                session = await store.get_session("sess_h1")
                assert session.title is None and session.cwd is None
                assert (await store.session_directory_fields("sess_h1"))["displayDevice"] is None

                # A sealed envelope is stored as-is.
                sealed_summary = summary("sess_h1", 3)
                sealed = {"mode": "sealed", "keyId": "dk1", "payload": "c2VhbGVk"}
                sealed_summary["summary"]["displayDevice"] = sealed
                item = device.state.push_outbox("session.summary", sealed_summary)
                await eventually(lambda: acked(device, item.oid))
                assert (await store.session_directory_fields("sess_h1"))["displayDevice"] == sealed

                # An encrypted command registered by the client converges from the device's outbox.
                registered_cmd = await client.post(
                    "/api/v3/e2ee/commands",
                    headers=headers,
                    json={"commandId": "cmd_h1", "deviceId": device_id, "inputDigest": DIGEST},
                )
                assert registered_cmd.status_code == 200, registered_cmd.text
                done = device.state.push_outbox(
                    "command.result",
                    {"commandId": "cmd_h1", "outcome": "rejected", "r": {"text": "secret"},
                     "e": {"code": "runtime_busy", "message": "secret detail", "retryable": False}},
                )
                await eventually(lambda: acked(device, done.oid))
                status = (await client.get("/api/v3/e2ee/commands/cmd_h1", headers=headers)).json()
                assert status["outcome"] == "rejected"

                # Receipts of Server-initiated commands keep the outcome only.
                device.state.command_handler = lambda method, p: {"localIP": "127.0.0.1", "note": "secret"}
                owner = (await store.get_connector(device_id)).userId
                outcome = await app.state.device_commands.send(
                    user_id=owner, device_id=device_id, kind="runtime.apply", command_id="cmd_h2",
                    payload={"runtimeId": "rti_h2", "runtimeType": "claude", "active": True, "config": None},
                )
                assert outcome.result == {}
                receipt = await store.get_device_command(owner, "cmd_h2")
                assert receipt["state"] == "accepted" and (receipt["result"] or {}).get("r") is None
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_off_mode_token_does_not_register_secure(mesh_router: RouterProcess, monkeypatch) -> None:
    monkeypatch.delenv("AGENT_SERVER_E2EE", raising=False)

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            _headers, device_id, token = await user_and_device(app, client)
            device, welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                assert welcome["e2eeMode"] == "off"
                registered = await app.state.device_mesh.registered_services(device_id)
                assert "aa.device.v1.Secure" not in registered
                assert {"aa.device.v1.Link", "aa.device.v1.Sessions", "aa.device.v1.Commands"} <= registered
            finally:
                await device.stop()

    asyncio.run(scenario())


def _sealed_summary(session_id: str, head: int, project_id: str | None = None) -> dict:
    body = summary(session_id, head)
    body["summary"]["displayDevice"] = {"mode": "sealed", "keyId": "dk1", "payload": "c2VhbGVk"}
    if project_id is not None:
        body["summary"]["projectId"] = project_id
    return body


def test_required_mode_places_sessions_by_project_id_or_leaves_them_for_the_client(
    mesh_router: RouterProcess, monkeypatch
) -> None:
    monkeypatch.setenv("AGENT_SERVER_E2EE", "required")

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            store = app.state.store
            projects = (await client.get("/api/v2/projects", headers=headers)).json()["projects"]
            project_id = projects[0]["id"]
            other = await client.post(
                "/api/v2/projects", headers=headers,
                json={"connectorId": device_id, "name": "other", "workspacePath": "/other"},
            )
            other_project = other.json()["project"]["id"]
            second_device = (await client.post("/api/v2/connectors", headers=headers, json={"name": "desk"})).json()
            elsewhere = await client.post(
                "/api/v2/projects", headers=headers,
                json={"connectorId": second_device["connector"]["id"], "name": "far", "workspacePath": "/far"},
            )
            elsewhere_project = elsewhere.json()["project"]["id"]
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                # Created through the channel: the device reports the project it was created in.
                item = device.state.push_outbox("session.summary", _sealed_summary("sess_p1", 1, project_id))
                await eventually(lambda: acked(device, item.oid))
                assert (await store.get_session("sess_p1")).projectId == project_id
                # Only the first report places it.
                again = device.state.push_outbox("session.summary", _sealed_summary("sess_p1", 2, other_project))
                await eventually(lambda: acked(device, again.oid))
                assert (await store.get_session("sess_p1")).projectId == project_id

                # Found by the device itself (or a project on another device): created unplaced.
                for session_id, reported in (("sess_p2", None), ("sess_p3", elsewhere_project)):
                    found = device.state.push_outbox("session.summary", _sealed_summary(session_id, 1, reported))
                    await eventually(lambda found=found: acked(device, found.oid))
                    assert (await store.get_session(session_id)).projectId is None
                # Later summaries keep it unplaced instead of failing.
                later = device.state.push_outbox("session.summary", _sealed_summary("sess_p2", 2))
                await eventually(lambda: acked(device, later.oid))
                assert (await store.session_directory_fields("sess_p2"))["headSeq"] == 2

                # The client assigns it.
                assigned = await client.patch("/api/v2/sessions/sess_p2/meta", headers=headers, json={"projectId": other_project})
                assert assigned.status_code == 200, assigned.text
                assert assigned.json()["session"]["projectId"] == other_project
                far = await client.patch(
                    "/api/v2/sessions/sess_p2/meta", headers=headers, json={"projectId": elsewhere_project}
                )
                assert far.status_code == 422 and far.json()["detail"]["code"] == "project_workspace_mismatch"
                missing = await client.patch("/api/v2/sessions/sess_p2/meta", headers=headers, json={"projectId": "prj_x"})
                assert missing.status_code == 404
                assert (await store.get_session("sess_p2")).projectId == other_project

                # Every place a session is served carries the envelopes (clients decrypt the list).
                envelope = {"mode": "sealed", "keyId": "dk1", "payload": "c2VhbGVk"}
                user_title = {"mode": "sealed", "keyId": "dk1", "payload": "dXNlcg=="}
                patched = await client.patch(
                    "/api/v2/sessions/sess_p2/meta", headers=headers, json={"displayUser": user_title}
                )
                assert patched.json()["session"]["displayUser"] == user_title
                assert patched.json()["session"]["displayDevice"] == envelope
                meta = (await client.get("/api/v2/sessions/sess_p2/meta", headers=headers)).json()["session"]
                listed = (await client.get("/api/v2/sessions", headers=headers)).json()["sessions"]
                inventory = (await client.get("/api/v2/sessions/list", headers=headers)).json()["sessions"]
                for view in (meta, next(s for s in listed if s["id"] == "sess_p2"),
                             next(s for s in inventory if s["id"] == "sess_p2")):
                    assert view["displayDevice"] == envelope and view["displayUser"] == user_title
                    assert view["planState"] == "none" and view["goalState"] == "active"
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_normal_mode_user_title_wins_over_the_device_title(mesh_router: RouterProcess, monkeypatch) -> None:
    monkeypatch.delenv("AGENT_SERVER_E2EE", raising=False)

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            store = app.state.store
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                first = device.state.push_outbox("session.summary", summary("sess_t1", 1, title="device one"))
                await eventually(lambda: acked(device, first.oid))
                assert (await store.get_session("sess_t1")).title == "device one"

                renamed = await client.patch("/api/v2/sessions/sess_t1/meta", headers=headers, json={"title": "mine"})
                assert renamed.status_code == 200, renamed.text
                assert renamed.json()["session"]["displayUser"] == {"mode": "plain", "payload": {"title": "mine"}}

                # The device keeps reporting its own title: displayDevice follows it, the title stays the user's.
                later = device.state.push_outbox("session.summary", summary("sess_t1", 2, title="device two"))
                await eventually(lambda: acked(device, later.oid))
                session = await store.get_session("sess_t1")
                assert session.title == "mine"
                assert session.displayDevice["payload"]["title"] == "device two"
                assert session.cwd == "/repo"

                # Encryption turned on: the next summary leaves no plaintext, not even the user's title.
                await device.stop()
                app.state.e2ee_settings = E2eeSettings(mode="required")
                device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
                encrypted = device.state.push_outbox("session.summary", summary("sess_t1", 3, title="device three"))
                await eventually(lambda: acked(device, encrypted.oid))
                session = await store.get_session("sess_t1")
                assert session.title is None and session.cwd is None
                assert session.displayUser is None and session.displayDevice is None

                # A sealed user title stays.
                sealed = {"mode": "sealed", "keyId": "dk1", "payload": "dXNlcg=="}
                await store.set_session_display_user("sess_t1", DisplayEnvelope.model_validate(sealed))
                again = device.state.push_outbox("session.summary", summary("sess_t1", 4))
                await eventually(lambda: acked(device, again.oid))
                assert (await store.get_session("sess_t1")).displayUser == sealed
            finally:
                await device.stop()

    asyncio.run(scenario())
