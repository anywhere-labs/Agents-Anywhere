"""v3 devices in normal mode: files, terminals, shell and slash commands through ``Client/call``.

Real Server app (in-process), a real MeshCall Router and the fake device's ``Client`` service.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from device_link_helpers import acked, eventually, server, summary, user_and_device
from mesh_fixtures import RouterProcess
from meshcall import MeshCallError
from starlette.websockets import WebSocketDisconnect

from agent_server.core.auth import create_user_access_token
from agent_server.core.device_meshcall import LinkError
from scripts.v3_fake_device import connect_device

ROOT = "/Users/dev/repo"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "client_routes"
FILE_BYTES = b"hello from the device\n" * 4096


def _recorded(name: str) -> Any:
    return json.loads((FIXTURES / f"{name}.json").read_text())["response"]


async def _stranger(app: Any) -> dict[str, str]:
    other = await app.state.store.create_user(user_id="user_other", password="password-other")
    return {"Authorization": f"Bearer {create_user_access_token(other.userId)}"}


def test_files_terminals_shell_reach_a_v3_device_through_client_call(
    mesh_router: RouterProcess, monkeypatch
) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            device, _welcome, access = await connect_device(client, connector_id=device_id, connector_token=token)
            state = device.state
            loop = asyncio.get_running_loop()
            uploads: list[Any] = []
            terminal_id = "trm_dev"

            def handle(request: dict[str, Any]) -> Any:
                route, body = request["route"], request["body"] or {}
                if "/terminals-v2/trm_gone" in request["path"]:
                    raise MeshCallError(
                        "not_found", "terminal not found", details={"source": "device", "aaCode": "terminal_not_found"}
                    )
                if route == "connector.fs.readText":
                    return 200, _recorded("device.fs.readText")
                if route == "connector.fs.read":
                    transfer = request["server"]["transfer"]
                    # Like the Connector: answer now, PUT the bytes to the Server's transfer in the background.
                    uploads.append(asyncio.run_coroutine_threadsafe(client.put(
                        transfer["path"],
                        content=FILE_BYTES,
                        headers={"Authorization": f"Bearer {access}", "X-Transfer-Token": transfer["token"]},
                    ), loop))
                    return 200, {"ok": True, "result": {
                        "path": body["path"], "name": "a.txt", "size": len(FILE_BYTES),
                        "sha256": hashlib.sha256(FILE_BYTES).hexdigest(), "mediaType": "text/plain",
                    }}
                if route == "connector.terminals.create":
                    return 200, {"ok": True, "result": {"terminalId": terminal_id, "root": request["query"]["root"]}}
                if route == "connector.terminals.list":
                    return 200, {"ok": True, "result": {"terminals": [{"terminalId": terminal_id}]}}
                if route == "connector.shell.exec":
                    return 200, {"ok": True, "result": {"exitCode": 0, "stdout": "hi\n", "stderr": ""}}
                if route == "connector.fs.list" and body.get("path") == "bogus":
                    return 200, {"entries": []}
                return 200, {"ok": True, "result": {"route": route}}

            state.client_handler = handle
            base = f"/api/v2/connectors/{device_id}"
            term = f"{base}/terminals-v2/{terminal_id}"
            try:
                # Each request reaches the device as the client sent it: route, path, query and body.
                sent = [
                    ("connector.fs.write", "POST", f"{base}/fs/write", {"root": ROOT},
                     {"path": "notes/a.txt", "content": "hello\n"}),
                    ("connector.fs.list", "POST", f"{base}/fs/list", {"root": ROOT}, {"path": "notes"}),
                    ("connector.fs.readText", "POST", f"{base}/fs/readText", {"root": ROOT}, {"path": "notes/a.txt"}),
                    ("connector.terminals.create", "POST", f"{base}/terminals-v2", {"root": ROOT},
                     {"cols": 100, "rows": 30, "label": "Build"}),
                    ("connector.terminals.list", "GET", f"{base}/terminals-v2", {}, None),
                    ("connector.terminals.rename", "PATCH", term, {}, {"label": "Renamed"}),
                    ("connector.terminals.persistence", "PATCH", f"{term}/persistence", {}, {"persistent": True}),
                    ("connector.terminals.resize", "POST", f"{term}/resize", {}, {"cols": 120, "rows": 40}),
                    ("connector.terminals.write", "POST", f"{term}/write", {}, {"dataBase64": "ZWNobyBoaQo="}),
                    ("connector.terminals.snapshot", "GET", f"{term}/snapshot", {"fromSeq": "0"}, None),
                    ("connector.shell.exec", "POST", f"{base}/shell/exec", {"root": ROOT},
                     {"command": "echo hi", "timeoutMs": 5000}),
                    ("connector.terminals.close", "DELETE", term, {}, None),
                ]
                answers: dict[str, Any] = {}
                for route, method, path, query, body in sent:
                    response = await client.request(method, path, params=query, json=body, headers=headers)
                    assert response.status_code == 200, (route, response.text)
                    answers[route] = response.json()
                    request = state.client_calls[-1]
                    assert (request["route"], request["method"], request["path"]) == (route, method, path)
                    assert request["query"] == query and request["body"] == body
                    assert request["server"] is None and request["caller"]["userId"] == "user_v3"
                assert answers["connector.fs.readText"]["content"] == "hello\n"
                assert answers["connector.terminals.create"]["result"] == {"terminalId": terminal_id, "root": ROOT}
                assert answers["connector.shell.exec"]["result"]["stdout"] == "hi\n"

                # A download: the Server allocates the transfer, the device uploads to it, the client reads it.
                read = await client.post(f"{base}/fs/read?root={ROOT}", headers=headers, json={"path": "notes/a.txt"})
                assert read.status_code == 200, read.text
                result = read.json()["result"]
                assert state.client_calls[-1]["server"]["transfer"]["transferId"] == result["transferId"]
                download = await client.get(result["downloadUrl"], headers=headers)
                assert download.status_code == 200, download.text
                assert download.content == FILE_BYTES
                assert (await asyncio.wrap_future(uploads[0])).status_code == 204

                # The device's own error code decides the status.
                missing = await client.patch(
                    f"{base}/terminals-v2/trm_gone/persistence", headers=headers, json={"persistent": False}
                )
                assert missing.status_code == 404, missing.text
                assert missing.json()["detail"]["code"] == "terminal_not_found"
                # An answer that does not match the route's response model.
                invalid = await client.post(f"{base}/fs/list?root={ROOT}", headers=headers, json={"path": "bogus"})
                assert invalid.status_code == 502 and invalid.json()["detail"]["code"] == "device_response_invalid"

                # Shell tasks report completion by notification, which v3 has no carrier for: not offered.
                calls = len(state.client_calls)
                task = await client.post(f"{base}/shell/tasks?root={ROOT}", headers=headers,
                                         json={"command": "sleep 1", "timeoutMs": 5000})
                assert task.status_code >= 400
                # Another user's device is not found and never asked.
                stranger = await _stranger(app)
                denied = await client.post(f"{base}/fs/list?root={ROOT}", headers=stranger, json={"path": "."})
                assert denied.status_code == 404, denied.text
                assert len(state.client_calls) == calls
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_slash_commands_are_forwarded_with_a_receipt(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            state = device.state
            catalog = {"current": _recorded("session.commands.list")}

            def handle(request: dict[str, Any]) -> Any:
                if request["route"] == "session.runtime.commands":
                    return 200, catalog["current"]
                if request["body"].get("command") == "busy":
                    return LinkError(code="session_busy", message="busy")
                return 200, _recorded("session.commands.execute")

            state.client_handler = handle
            try:
                pushed = state.push_outbox("session.summary", summary("sess_cmd", 3))
                await eventually(lambda: acked(device, pushed.oid))
                taken = await client.post("/api/v2/sessions/sess_cmd/takeover", headers=headers)
                assert taken.status_code == 200, taken.text
                url = "/api/v2/sessions/sess_cmd/runtime/commands"

                listed = await client.get(f"{url}?query=AGENTS&limit=5", headers=headers)
                assert listed.status_code == 200, listed.text
                assert [c["id"] for c in listed.json()["commands"]] == ["review"]
                request = state.client_calls[-1]
                assert request["route"] == "session.runtime.commands" and request["path"] == url
                assert request["query"] == {"query": "AGENTS", "limit": "5"}

                ran = await client.post(
                    url, headers=headers,
                    json={"command": "review", "args": ["src"], "raw": "/review  src\nplease", "operationId": "op_cmd_1"},
                )
                assert ran.status_code == 200, ran.text
                assert ran.json()["ok"] is True and ran.json()["result"]["executionState"] == "accepted"
                request = state.client_calls[-1]
                assert request["route"] == "session.runtime.commands.execute"
                assert request["command"]["commandId"] == "op_cmd_1" and request["server"] == {"takeover": True, "archived": False}
                assert request["body"]["raw"] == "/review  src\nplease"
                receipt = await app.state.store.get_device_command("user_v3", "op_cmd_1")
                assert (receipt["kind"], receipt["state"], receipt["sessionId"]) == (
                    "session.runtime.commands.execute", "accepted", "sess_cmd"
                )

                # The same operation again is answered by the device's inbox.
                runs = len(state.client_runs)
                again = await client.post(
                    url, headers=headers,
                    json={"command": "review", "args": ["src"], "raw": "/review  src\nplease", "operationId": "op_cmd_1"},
                )
                assert again.status_code == 200 and len(state.client_runs) == runs

                # Without an operation id the Server generates one and writes it into the body.
                generated = await client.post(url, headers=headers, json={"command": "init", "args": []})
                assert generated.status_code == 200, generated.text
                request = state.client_calls[-1]
                assert request["command"]["commandId"].startswith("c_")
                assert request["body"]["operationId"] == request["command"]["commandId"]

                refused = await client.post(url, headers=headers, json={"command": "busy", "args": []})
                assert refused.status_code == 409 and refused.json()["detail"]["code"] == "session_busy"

                catalog["current"] = {"commands": "nope"}
                invalid = await client.get(url, headers=headers)
                assert invalid.status_code == 502 and invalid.json()["detail"]["code"] == "device_response_invalid"

                stranger = await _stranger(app)
                calls = len(state.client_calls)
                assert (await client.get(url, headers=stranger)).status_code == 404
                denied = await client.post(url, headers=stranger, json={"command": "review", "args": []})
                assert denied.status_code == 404
                assert len(state.client_calls) == calls
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_the_terminal_socket_holds_one_device_subscription(mesh_router: RouterProcess, monkeypatch) -> None:
    from conftest import make_test_client

    monkeypatch.setenv("AGENT_SERVER_MESH_ROUTER_URL", mesh_router.url)
    monkeypatch.setenv("AGENT_SERVER_MESH_PASSWORD", mesh_router.password)
    monkeypatch.setenv("AGENT_SERVER_MESH_PUBLIC_URL", mesh_router.url)

    async def connect(app: Any, device_id: str, token: str) -> Any:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://server") as http:
            device, _welcome, _access = await connect_device(http, connector_id=device_id, connector_token=token)
        return device

    with make_test_client() as client:
        store = client.app.state.store
        user = client.portal.call(lambda: store.create_user(user_id="user_term", password="password-term"))
        other = client.portal.call(lambda: store.create_user(user_id="user_peer", password="password-peer"))
        headers = {"Authorization": f"Bearer {create_user_access_token(user.userId)}"}
        created = client.post("/connectors", headers=headers, json={"name": "laptop"}).json()
        device_id, token = created["connector"]["id"], created["connectorToken"]
        device = client.portal.call(connect, client.app, device_id, token)

        def path(owner: Any = user) -> str:
            owner_headers = {"Authorization": f"Bearer {create_user_access_token(owner.userId)}"}
            ticket = client.post(
                "/ws-ticket", headers=owner_headers, json={"clientId": "web_term", "scope": {"dashboard": True}}
            ).json()["ticket"]
            return f"/connectors/{device_id}/terminals-v2/trm_1/stream?fromSeq=0&ticket={ticket}"

        try:
            state = device.state
            queue = state.client_terminal_items["trm_1"]
            queue.append({"type": "replay", "data": base64.b64encode(b"$ ").decode(), "seq": 2})

            def refuse(request: dict[str, Any]) -> Any:
                return 409, {"detail": {"code": "terminal_exited", "message": "the terminal has exited"}}

            state.client_handler = refuse
            with client.websocket_connect(path()) as ws:
                assert ws.receive_json() == {"type": "replay", "data": "JCA=", "seq": 2}
                client.portal.call(_until, lambda: state.client_subscribers["trm_1"] == 1)
                # The device refuses the input: an error frame, and the socket stays open.
                ws.send_json({"type": "input", "data": "cHdkCg=="})
                assert ws.receive_json() == {"type": "error", "code": 409, "message": "the terminal has exited"}
                ws.send_json({"type": "ping"})
                assert ws.receive_json() == {"type": "pong"}
            # Closing the socket cancels the device stream.
            client.portal.call(_until, lambda: state.client_subscribers["trm_1"] == 0)

            # Another user's ticket does not open this device's terminal.
            subscriptions = len(state.client_subscriptions)
            with pytest.raises(WebSocketDisconnect) as closed, client.websocket_connect(path(other)) as ws:
                ws.receive_json()
            assert closed.value.code == 4404
            assert len(state.client_subscriptions) == subscriptions
        finally:
            with contextlib.suppress(Exception):
                client.portal.call(device.stop)


async def _until(check: Any, timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not check():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.02)
