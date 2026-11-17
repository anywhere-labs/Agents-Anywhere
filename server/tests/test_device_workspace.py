"""v3 devices in normal mode: files, terminals, shell and slash commands through the v2 routes.

Real Server app (in-process), a real MeshCall Router and the fake device. The ``Workspace/call``
and ``Workspace/terminalOutput`` requests the Server sends are pinned in
``connector-ts/test/fixtures/server-workspace-calls.json``; the TS Connector's tests replay that
file against the real device handlers, so a change on either side fails one of them. Regenerate it
with ``AA_WRITE_WORKSPACE_FIXTURE=1``.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path
from typing import Any

import httpx
from device_link_helpers import acked, eventually, server, summary, user_and_device
from mesh_fixtures import RouterProcess
from meshcall import MeshCallError

from agent_server.core.device_meshcall import WORKSPACE_METHODS, TerminalOutputItem
from agent_server.services.terminal_relay import TerminalRelayService
from scripts.v3_fake_device import connect_device

ROOT = "/Users/dev/repo"
FIXTURE = Path(__file__).resolve().parents[2] / "connector-ts/test/fixtures/server-workspace-calls.json"
FILE_BYTES = b"hello from the device\n" * 4096


def _placeholders(value: Any, names: dict[str, str]) -> Any:
    """Dynamic values (ids, tokens, the root) as ``{name}`` so the fixture is stable."""

    if isinstance(value, dict):
        return {key: _placeholders(item, names) for key, item in value.items()}
    if isinstance(value, list):
        return [_placeholders(item, names) for item in value]
    if isinstance(value, str):
        for actual, name in sorted(names.items(), key=lambda pair: -len(pair[0])):
            value = value.replace(actual, "{" + name + "}")
    return value


def _check_fixture(recorded: dict[str, Any]) -> None:
    if os.environ.get("AA_WRITE_WORKSPACE_FIXTURE") == "1":
        FIXTURE.write_text(json.dumps(recorded, indent=2, sort_keys=True) + "\n")
        return
    assert FIXTURE.exists(), f"{FIXTURE} is missing; run with AA_WRITE_WORKSPACE_FIXTURE=1"
    assert json.loads(FIXTURE.read_text()) == recorded, (
        "the Server's Workspace requests changed; regenerate the fixture with AA_WRITE_WORKSPACE_FIXTURE=1 "
        "and run the connector-ts workspace tests"
    )


def test_files_terminals_shell_reach_a_v3_device_through_workspace_call(
    mesh_router: RouterProcess, monkeypatch
) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            device, _welcome, access = await connect_device(client, connector_id=device_id, connector_token=token)
            loop = asyncio.get_running_loop()
            uploads: list[Any] = []

            def handler(method: str, params: dict[str, Any]) -> Any:
                if params.get("terminalId") == "trm_gone":
                    raise MeshCallError("terminal_not_found", "terminal not found", details={"source": "device"})
                if method == "fs.readText":
                    return {"path": params["path"], "name": "a.txt", "size": 6, "sha256": "0" * 64,
                            "encoding": "utf8", "content": "hello\n", "truncated": False, "binary": False}
                if method == "fs.prepareDownload":
                    return {"path": params["path"], "name": "a.txt", "size": len(FILE_BYTES),
                            "sha256": hashlib.sha256(FILE_BYTES).hexdigest(), "mediaType": "text/plain"}
                if method == "fs.uploadPreparedDownload":
                    # Like the Connector: answer now, PUT the bytes in the background.
                    uploads.append(asyncio.run_coroutine_threadsafe(client.put(
                        params["uploadUrl"],
                        content=FILE_BYTES,
                        headers={"Authorization": f"Bearer {access}", "X-Transfer-Token": params["token"]},
                    ), loop))
                    return {"transferId": params["transferId"], "uploadStarted": True}
                if method == "terminal.create":
                    return {"terminalId": params["terminalId"], "sessionId": params["sessionId"], "pid": 7,
                            "cwd": params["cwd"], "cols": params["cols"], "rows": params["rows"], "status": "running"}
                if method == "terminal.list":
                    return {"terminals": [{"terminalId": tid, "sessionId": params["sessionId"], "status": "running"}
                                          for tid in terminals]}
                if method == "terminal.snapshot":
                    return {"terminal": {"terminalId": params["terminalId"], "status": "running"},
                            "baseSeq": 0, "seq": 2, "dataBase64": "aGk=", "outputs": []}
                if method == "shell.exec":
                    return {"exitCode": 0, "stdout": "hi\n", "stderr": "", "timedOut": False}
                return {"terminalId": params.get("terminalId"), "ok": True}

            terminals: list[str] = []
            device.state.workspace_handler = handler
            base = f"/api/v2/connectors/{device_id}"
            try:
                written = await client.post(f"{base}/fs/write?root={ROOT}", headers=headers,
                                            json={"path": "notes/a.txt", "content": "hello\n"})
                assert written.status_code == 200, written.text
                listed = await client.post(f"{base}/fs/list?root={ROOT}", headers=headers, json={"path": "notes"})
                assert listed.status_code == 200, listed.text
                text = await client.post(f"{base}/fs/readText?root={ROOT}", headers=headers,
                                         json={"path": "notes/a.txt"})
                assert text.status_code == 200 and text.json()["content"] == "hello\n", text.text

                # A download: prepared on the device, bytes through the v3 transfer relay.
                read = await client.post(f"{base}/fs/read?root={ROOT}", headers=headers, json={"path": "notes/a.txt"})
                assert read.status_code == 200, read.text
                body = read.json()["result"]
                download = await client.get(body["downloadUrl"], headers=headers)
                assert download.status_code == 200, download.text
                assert download.content == FILE_BYTES
                assert (await asyncio.wrap_future(uploads[0])).status_code == 204
                transfer_id, transfer_token = body["transferId"], body["token"]

                created = await client.post(f"{base}/terminals-v2?root={ROOT}", headers=headers,
                                            json={"cols": 100, "rows": 30, "label": "Build"})
                assert created.status_code == 200, created.text
                terminal_id = created.json()["result"]["terminalId"]
                terminals.append(terminal_id)
                assert created.json()["result"]["root"] == ROOT
                listed_terms = await client.get(f"{base}/terminals-v2", headers=headers)
                assert [t["terminalId"] for t in listed_terms.json()["result"]["terminals"]] == [terminal_id]
                term = f"{base}/terminals-v2/{terminal_id}"
                assert (await client.patch(term, headers=headers, json={"label": "Renamed"})).status_code == 200
                persisted = await client.patch(f"{term}/persistence", headers=headers, json={"persistent": True})
                assert persisted.status_code == 200, persisted.text
                resized = await client.post(f"{term}/resize", headers=headers, json={"cols": 120, "rows": 40})
                assert resized.status_code == 200, resized.text
                typed = await client.post(f"{term}/write", headers=headers, json={"dataBase64": "ZWNobyBoaQo="})
                assert typed.status_code == 200, typed.text
                snap = await client.get(f"{term}/snapshot?fromSeq=0", headers=headers)
                assert snap.status_code == 200, snap.text
                assert snap.json()["result"]["dataBase64"] == "aGk=" and snap.json()["result"]["terminal"]["root"] == ROOT

                # The output stream as the terminal WebSocket opens it (``TerminalRelayService.output``).
                relay = TerminalRelayService(
                    app.state.terminal_roots, app.state.rpc, app.state.terminal_broker, app.state.device_rpc_bridge
                )
                device.state.terminal_items[terminal_id].extend([
                    TerminalOutputItem(m="terminal.replay", p={"terminalId": terminal_id, "seq": 1, "dataBase64": "JA=="}),
                    TerminalOutputItem(m="terminal.exited", p={"terminalId": terminal_id, "exitCode": 0, "reason": "exit"}),
                ])
                frames = [frame async for frame in relay.output(device_id, terminal_id, 0)]
                assert frames == [{"type": "replay", "data": "JA==", "seq": 1},
                                  {"type": "exit", "exitCode": 0, "reason": "exit"}]

                ran = await client.post(f"{base}/shell/exec?root={ROOT}", headers=headers,
                                        json={"command": "echo hi", "timeoutMs": 5000})
                assert ran.status_code == 200 and ran.json()["result"]["stdout"] == "hi\n", ran.text
                closed = await client.delete(term, headers=headers)
                assert closed.status_code == 200, closed.text

                # The device's own error code survives the bridge.
                missing = await client.patch(f"{base}/terminals-v2/trm_gone/persistence", headers=headers,
                                             json={"persistent": False})
                assert missing.status_code == 404, missing.text
                gone = await client.delete(f"{base}/terminals-v2/trm_gone", headers=headers)
                assert gone.status_code >= 400
                # Shell tasks report completion by notification, which v3 has no carrier for: not offered.
                task = await client.post(f"{base}/shell/tasks?root={ROOT}", headers=headers,
                                         json={"command": "sleep 1", "timeoutMs": 5000})
                assert task.status_code >= 400
                assert not any(method.startswith("shell.task") for method, _ in device.state.workspace_calls)
                # A method outside the whitelist never reaches the device's handlers.
                rpc = app.state.rpc
                try:
                    await rpc.request(device_id, "terminal.relay.connect", {"terminalId": terminal_id}, timeout=5)
                except Exception as exc:  # noqa: BLE001
                    assert getattr(exc, "code", "") == "device_method_unsupported"
                else:
                    raise AssertionError("terminal.relay.connect reached a v3 device")

                calls = [(m, p) for m, p in device.state.workspace_calls if p.get("terminalId") != "trm_gone"]
                assert {m for m, _ in calls} <= set(WORKSPACE_METHODS)
                names = {ROOT: "root", terminal_id: "terminalId", transfer_id: "transferId",
                         transfer_token: "token", device_id: "deviceId"}
                _check_fixture(
                    {
                        "comment": "Workspace/call requests the Server sends for the v2 routes "
                        "(server/tests/test_device_workspace.py); replayed by connector-ts/test/link/workspace.test.ts.",
                        "calls": [{"method": m, "params": _placeholders(p, names)} for m, p in calls],
                        "terminalOutput": _placeholders(device.state.terminal_requests[-1], names),
                    }
                )
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_slash_commands_use_the_device_catalog_and_send_a_message(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                pushed = device.state.push_outbox("session.summary", summary("sess_cmd", 3))
                await eventually(lambda: acked(device, pushed.oid))
                taken = await client.post("/api/v2/sessions/sess_cmd/takeover", headers=headers)
                assert taken.status_code == 200, taken.text
                device.state.capability_ids = ["session.commands", "session.send_message"]
                device.state.catalogs["sess_cmd"] = {
                    "models": [],
                    "commands": [
                        {"name": "review", "description": "Review the diff", "inputHint": "files"},
                        {"name": "init", "description": "Write AGENTS.md"},
                    ],
                }
                url = "/api/v2/sessions/sess_cmd/runtime/commands"
                listed = await client.get(url, headers=headers)
                assert listed.status_code == 200, listed.text
                commands = listed.json()["commands"]
                assert [c["id"] for c in commands] == ["review", "init"]
                assert commands[0]["acceptsArgs"] is True
                assert commands[0]["argsSchema"] == {"type": "string", "description": "files"}
                assert commands[0]["metadata"]["ui"]["kind"] == "execute"
                filtered = await client.get(f"{url}?query=AGENTS&limit=5", headers=headers)
                assert [c["id"] for c in filtered.json()["commands"]] == ["init"]

                ran = await client.post(url, headers=headers,
                                        json={"command": "review", "args": ["src"], "raw": "/review  src\nplease"})
                assert ran.status_code == 200, ran.text
                assert ran.json()["ok"] is True and ran.json()["result"]["executionState"] == "accepted"
                method, payload = device.state.command_log[-1]
                assert method == "session.sendMessage"
                assert payload["sessionId"] == "sess_cmd" and payload["content"] == "/review  src\nplease"
                assert payload["clientMessageId"] == ran.json()["result"]["clientMessageId"]

                unknown = await client.post(url, headers=headers, json={"command": "deploy", "args": []})
                assert unknown.status_code == 200
                assert unknown.json()["ok"] is False and unknown.json()["code"] == "command_unavailable"
                mismatch = await client.post(url, headers=headers, json={"command": "init", "raw": "/review x"})
                assert mismatch.json()["code"] == "invalid_command"
                assert len([m for m, _ in device.state.command_log if m == "session.sendMessage"]) == 1
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_terminal_stream_relays_the_device_output_stream(mesh_router: RouterProcess, monkeypatch) -> None:
    from conftest import make_test_client

    from agent_server.core.auth import create_user_access_token

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
        headers = {"Authorization": f"Bearer {create_user_access_token(user.userId)}"}
        created = client.post("/connectors", headers=headers, json={"name": "laptop"}).json()
        device_id, token = created["connector"]["id"], created["connectorToken"]
        device = client.portal.call(connect, client.app, device_id, token)

        def ticket() -> str:
            return client.post(
                "/ws-ticket", headers=headers, json={"clientId": "web_term", "scope": {"dashboard": True}}
            ).json()["ticket"]

        def item(m: str, **p: Any) -> TerminalOutputItem:
            return TerminalOutputItem(m=m, p={"terminalId": "trm_1", **p})  # type: ignore[arg-type]

        try:
            queue = device.state.terminal_items["trm_1"]
            queue.extend([
                item("terminal.replay", seq=2, dataBase64=base64.b64encode(b"$ ").decode()),
                item("terminal.output", seq=3, dataBase64=base64.b64encode(b"ls\n").decode()),
            ])
            def path(terminal_id: str = "trm_1") -> str:
                return f"/connectors/{device_id}/terminals-v2/{terminal_id}/stream?fromSeq=0&ticket={ticket()}"

            with client.websocket_connect(path()) as ws:
                assert ws.receive_json() == {"type": "replay", "data": "JCA=", "seq": 2}
                assert ws.receive_json() == {"type": "output", "data": "bHMK", "seq": 3}
                assert device.state.terminal_requests[-1] == {
                    "terminalId": "trm_1", "sessionId": f"browse_{device_id}", "fromSeq": 0
                }
                ws.send_json({"type": "input", "data": "cHdkCg=="})
                ws.send_json({"type": "resize", "cols": 900, "rows": 50})
                ws.send_json({"type": "ping"})
                assert ws.receive_json() == {"type": "pong"}
                queue.append(item("terminal.exited", exitCode=0, reason="exit"))
                assert ws.receive_json() == {"type": "exit", "exitCode": 0, "reason": "exit"}
            calls = [(m, p) for m, p in device.state.workspace_calls if m.startswith("terminal.")]
            assert calls[0] == ("terminal.write", {"terminalId": "trm_1", "sessionId": f"browse_{device_id}",
                                                   "dataBase64": "cHdkCg=="})
            assert calls[1] == ("terminal.resize", {"terminalId": "trm_1", "sessionId": f"browse_{device_id}",
                                                    "cols": 500, "rows": 50})

            # Closing the socket cancels the device stream (unsubscribe).
            queue.append(item("terminal.replay", seq=3, dataBase64=""))
            with client.websocket_connect(path()) as ws:
                assert ws.receive_json()["type"] == "replay"
                client.portal.call(_until, lambda: device.state.terminal_subscribers["trm_1"] == 1)
            client.portal.call(_until, lambda: device.state.terminal_subscribers["trm_1"] == 0)

            # A terminal the device does not know: an error frame, then the socket closes.
            with client.websocket_connect(path("trm_none")) as ws:
                error = ws.receive_json()
                assert error["type"] == "error" and error["code"] == 404
        finally:
            with contextlib.suppress(Exception):
                client.portal.call(device.stop)


async def _until(check: Any, timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not check():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not reached")
        await asyncio.sleep(0.02)
