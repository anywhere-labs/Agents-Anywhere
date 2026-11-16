"""E2EE ``required`` mode on the device link (F's handover list, ``contracts/e2ee/1.0``).

- The device token and the fake device follow the per-mode registration table.
- A plaintext display envelope a device still sends is dropped, a sealed one is stored.
- Outbox ``command.result`` settles encrypted command registrations; receipts keep no result body.
"""

from __future__ import annotations

import asyncio

from device_link_helpers import acked, eventually, server, summary, user_and_device
from mesh_fixtures import RouterProcess

from agent_server.core.device_meshcall import registered_services
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
                    user_id=owner, device_id=device_id, kind="runtime.apply", command_id="cmd_h2", payload={},
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
