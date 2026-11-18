"""Client routes forwarded with ``Client/call`` / ``Client/subscribe`` (docs/v3/14-unified-client-path.md §B, §C).

Real Server app, a real MeshCall Router and the fake device's ``Client`` service; every device-served route of a
device-meshcall device goes through ``Client/call``.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
from pathlib import Path
from typing import Any

import httpx
import pytest
from device_link_helpers import (
    acked,
    eventually,
    offline,
    server,
    summary,
    timeline_item,
    user_and_device,
)
from mesh_fixtures import RouterProcess
from meshcall import MeshCallError

from agent_server.core.client_routes import ROUTES_BY_ID
from agent_server.core.device_meshcall import LinkError
from agent_server.services.client_forward import (
    client_input_digest,
    command_identity,
)
from scripts.v3_fake_device import connect_device

SID = "sess_cf1"
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "client_routes"
BASE = f"/api/v2/sessions/{SID}"


def _timeline(count: int, text: str = "hello") -> dict[str, Any]:
    return {
        "sessionId": SID,
        "items": [
            {**timeline_item(SID, order, f"{text} {order}"), "updatedSeq": order} for order in range(1, count + 1)
        ],
        "nextSeq": count,
        "hasMore": False,
        "serverTime": "2026-11-17T10:00:00Z",
    }


async def _session(app: Any, client: httpx.AsyncClient, *, timeouts: bool = False) -> tuple[dict[str, str], str, Any]:
    headers, device_id, token = await user_and_device(app, client)
    device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
    pushed = device.state.push_outbox("session.summary", summary(SID, 0))
    await eventually(lambda: acked(device, pushed.oid))
    assert (await client.post(f"{BASE}/takeover", headers=headers)).status_code == 200
    return headers, device_id, device


def _detail(response: httpx.Response) -> dict[str, Any]:
    return response.json()["detail"]


def test_command_identity_takes_or_generates_the_route_field() -> None:
    messages = ROUTES_BY_ID["session.runtime.messages"]
    assert command_identity(messages, {"clientMessageId": "m_1", "content": "hi"}) == (
        "m_1",
        {"clientMessageId": "m_1", "content": "hi"},
    )
    generated, body = command_identity(messages, {"content": "hi"})
    assert generated and generated.startswith("c_") and body == {"content": "hi", "clientMessageId": generated}
    interrupt, body = command_identity(ROUTES_BY_ID["session.runtime.interrupt"], None)
    assert interrupt and interrupt.startswith("c_") and body is None
    assert command_identity(ROUTES_BY_ID["session.timeline"], None) == (None, None)
    assert client_input_digest("a", {"x": 1}) != client_input_digest("b", {"x": 1})


def test_reads_are_forwarded_chunked_checked_and_errors_mapped(mesh_router: RouterProcess, monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SERVER_DEVICE_READ_TIMEOUT_SECONDS", "1")

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, device = await _session(app, client)
            state = device.state
            try:
                # Forwarded with the route id, the client's path and query, and who asked; the body arrives
                # in chunks and is joined.
                body = _timeline(40, "x" * 200)
                state.client_handler = lambda request: (200, body)
                state.client_chunk_bytes = 1024
                response = await client.get(f"{BASE}/timeline", params={"mode": "latest"}, headers=headers)
                assert response.status_code == 200, response.text
                assert [item["id"] for item in response.json()["items"]] == [f"tl_{n}" for n in range(1, 41)]
                request = state.client_calls[-1]
                assert request["route"] == "session.timeline" and request["method"] == "GET"
                assert request["path"] == f"{BASE}/timeline" and request["query"] == {"mode": "latest"}
                assert request["caller"]["userId"] == "user_v3" and request["command"] is None

                # A body that does not match the route's response model.
                state.client_handler = lambda request: (200, {"bogus": True})
                invalid = await client.get(f"{BASE}/timeline", headers=headers)
                assert invalid.status_code == 502 and _detail(invalid)["code"] == "device_response_invalid"

                # The device's status and body pass through.
                state.client_handler = lambda request: (
                    404, {"detail": {"code": "session_not_found", "message": "no such session"}}
                )
                missing = await client.get(f"{BASE}/timeline", headers=headers)
                assert missing.status_code == 404 and _detail(missing)["code"] == "session_not_found"

                # A device error before the head: its AA code decides the status.
                def refuse(request: dict[str, Any]) -> Any:
                    raise MeshCallError(
                        "failed_precondition", "nope", details={"source": "device", "aaCode": "path_not_allowed"}
                    )

                state.client_handler = refuse
                refused = await client.post(
                    f"/api/v2/connectors/{device_id}/fs/list", params={"root": "/repo"}, json={"path": "."},
                    headers=headers,
                )
                assert refused.status_code == 403 and _detail(refused)["code"] == "path_not_allowed"

                # Busy lane: 503, retryable.
                def busy(request: dict[str, Any]) -> Any:
                    raise MeshCallError("resource_exhausted", "lane full", details={"source": "device"})

                state.client_handler = busy
                overloaded = await client.get(f"{BASE}/timeline", headers=headers)
                assert overloaded.status_code == 503
                assert _detail(overloaded) == {"code": "device_busy", "message": "lane full", "retryable": True}

                # Opened, then no answer in time: never reported as offline.
                state.client_handler = lambda request: (200, _timeline(1))
                state.client_delay = 3
                late = await client.get(f"{BASE}/timeline", headers=headers)
                assert late.status_code == 504 and _detail(late)["code"] == "device_read_timeout"
                state.client_delay = 0

                # An answer over the response limit.
                with monkeypatch.context() as patched:
                    patched.setattr("agent_server.services.client_forward.MAX_RESPONSE_BYTES", 2048)
                    state.client_handler = lambda request: (200, _timeline(40, "y" * 200))
                    huge = await client.get(f"{BASE}/timeline", headers=headers)
                assert huge.status_code == 500 and _detail(huge)["code"] == "response_too_large"
            finally:
                await device.stop()

            # Not delivered: routes with an offline answer synthesize it, the others answer 409.
            await eventually(lambda: offline(app.state.connector_presence, device_id))
            calls = len(device.state.client_calls)
            timeline = await client.get(f"{BASE}/timeline", headers=headers)
            assert timeline.status_code == 200
            assert timeline.json()["deviceOffline"] is True and timeline.json()["historySource"] == "unavailable"
            events = await client.get(f"{BASE}/events", params={"after": "seq:7"}, headers=headers)
            assert events.json()["deviceOffline"] is True and events.json()["nextCursor"] == "seq:7"
            notices = await client.get(f"{BASE}/runtime/notices", headers=headers)
            assert notices.status_code == 409 and _detail(notices)["code"] == "connector_offline"
            assert len(device.state.client_calls) == calls

    asyncio.run(scenario())


def test_snapshot_gets_the_servers_session_catalogs_and_capabilities(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, _device_id, device = await _session(app, client)
            try:
                device.state.client_handler = lambda request: (200, {
                    "session": {"id": "the device's own view"},
                    "timeline": {
                        "items": [{**timeline_item(SID, 1, "hi"), "updatedSeq": 1}], "nextSeq": 1, "hasMore": False
                    },
                    "notices": [],
                    "eventCursor": "seq:1",
                    "serverTime": "2026-11-17T10:00:00Z",
                })
                response = await client.get(f"{BASE}/snapshot", headers=headers)
                assert response.status_code == 200, response.text
                body = response.json()
                assert body["session"]["id"] == SID and body["session"]["title"] == "Fix the build"
                assert body["timeline"]["items"][0]["id"] == "tl_1"
                assert body["historySource"] == "live" and body["deviceOffline"] is False
                assert "capabilities" in body["effectiveCapabilities"]
                assert device.state.client_calls[-1]["route"] == "session.snapshot"
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_command_receipts_register_settle_and_replay(mesh_router: RouterProcess, monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SERVER_DEVICE_COMMAND_TIMEOUT_SECONDS", "1")

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, device = await _session(app, client)
            state, store = device.state, app.state.store
            user_id = (await store.get_connector(device_id)).userId
            accepted = {"ok": True, "result": {"delivery": "accepted"}}
            send = f"{BASE}/runtime/messages"
            try:
                # Registered before the call, settled from the head; the device gets the receipt identity and
                # the Server's facts.
                state.client_handler = lambda request: (200, accepted)
                first = await client.post(send, json={"clientMessageId": "m_1", "content": "hi"}, headers=headers)
                assert first.status_code == 200 and first.json()["result"] == {"delivery": "accepted"}
                request = state.client_calls[-1]
                assert request["command"]["commandId"] == "m_1"
                assert request["command"]["inputDigest"] == client_input_digest(
                    "session.runtime.messages", {"clientMessageId": "m_1", "content": "hi"}
                )
                assert request["server"] == {"takeover": True, "archived": False}
                receipt = await store.get_device_command(user_id, "m_1")
                assert (receipt["origin"], receipt["kind"], receipt["state"]) == (
                    "client", "session.runtime.messages", "accepted"
                )
                assert receipt["sessionId"] == SID and receipt["payload"] is None and receipt["result"] is None

                # Accepted: forwarded again with the same id; the device's inbox answers, nothing runs twice.
                runs = len(state.client_runs)
                again = await client.post(send, json={"clientMessageId": "m_1", "content": "hi"}, headers=headers)
                assert again.status_code == 200 and again.json() == first.json()
                assert len(state.client_runs) == runs and state.client_calls[-1]["command"]["commandId"] == "m_1"

                # Same id, other input.
                conflict = await client.post(send, json={"clientMessageId": "m_1", "content": "no"}, headers=headers)
                assert conflict.status_code == 409 and _detail(conflict)["code"] == "command_conflict"

                # Rejected: the stored error code answers the replay; the device is not asked again.
                state.client_handler = lambda request: LinkError(code="session_busy", message="busy")
                rejected = await client.post(send, json={"clientMessageId": "m_2", "content": "hi"}, headers=headers)
                assert rejected.status_code == 409 and _detail(rejected)["code"] == "session_busy"
                assert (await store.get_device_command(user_id, "m_2"))["result"] == {
                    "e": {"code": "session_busy", "retryable": False}
                }
                calls = len(state.client_calls)
                replayed = await client.post(send, json={"clientMessageId": "m_2", "content": "hi"}, headers=headers)
                assert replayed.status_code == 409 and _detail(replayed)["code"] == "session_busy"
                assert len(state.client_calls) == calls

                # Unknown: the call opened and timed out. A replay asks Commands/status first; once the device
                # knows the outcome the command is forwarded again and its inbox replays the answer.
                state.client_handler = lambda request: (200, accepted)
                state.client_delay = 2
                unknown = await client.post(send, json={"clientMessageId": "m_u", "content": "hi"}, headers=headers)
                assert unknown.status_code == 504 and _detail(unknown)["code"] == "command_outcome_unknown"
                assert (await store.get_device_command(user_id, "m_u"))["state"] == "unknown"
                # Still running on the device: the replay answers 504 without sending it again.
                calls = len(state.client_calls)
                pending = await client.post(send, json={"clientMessageId": "m_u", "content": "hi"}, headers=headers)
                assert pending.status_code == 504 and len(state.client_calls) == calls
                await eventually(lambda: _known(state, "m_u"))
                state.client_delay = 0
                settled = await client.post(send, json={"clientMessageId": "m_u", "content": "hi"}, headers=headers)
                assert settled.status_code == 200 and state.client_runs.count("session.runtime.messages") == 3
                assert (await store.get_device_command(user_id, "m_u"))["state"] == "accepted"

                # A missing id is generated and written into the body (respond) or kept apart (interrupt).
                state.client_handler = lambda request: (200, {"ok": True, "result": {}})
                respond = await client.post(
                    f"{BASE}/runtime/notices/n_1/respond", json={"actionId": "approve"}, headers=headers
                )
                assert respond.status_code == 200, respond.text
                request = state.client_calls[-1]
                assert request["body"]["responseId"] == request["command"]["commandId"]
                assert request["command"]["commandId"].startswith("c_")
                interrupt = await client.post(f"{BASE}/runtime/interrupt", headers=headers)
                assert interrupt.status_code == 200
                request = state.client_calls[-1]
                assert request["command"]["commandId"].startswith("c_") and request["body"] is None
                generated = await store.get_device_command(user_id, request["command"]["commandId"])
                assert generated["kind"] == "session.runtime.interrupt" and generated["state"] == "accepted"

                # A body over 1 MiB never reaches the device.
                calls = len(state.client_calls)
                large = await client.post(send, json={"content": "x" * (1024 * 1024 + 1)}, headers=headers)
                assert large.status_code == 413 and _detail(large)["code"] == "request_too_large"
                assert len(state.client_calls) == calls

                # A 5xx without a settled command leaves the outcome to Commands/status.
                state.client_handler = lambda request: {
                    "status": 500, "body": {"detail": {"code": "internal", "message": "boom"}}, "command": None
                }
                failed = await client.post(send, json={"clientMessageId": "m_5", "content": "hi"}, headers=headers)
                assert failed.status_code == 500
                assert (await store.get_device_command(user_id, "m_5"))["state"] == "unknown"

                # Busy lane: the receipt is dropped, a retry is a fresh attempt.
                def busy(request: dict[str, Any]) -> Any:
                    raise MeshCallError("resource_exhausted", "lane full", details={"source": "device"})

                state.client_handler = busy
                overloaded = await client.post(send, json={"clientMessageId": "m_b", "content": "hi"}, headers=headers)
                assert overloaded.status_code == 503 and _detail(overloaded)["code"] == "device_busy"
                assert await store.get_device_command(user_id, "m_b") is None
            finally:
                await device.stop()

            # Not delivered: the receipt is dropped and the client gets connector_offline.
            await eventually(lambda: offline(app.state.connector_presence, device_id))
            gone = await client.post(send, json={"clientMessageId": "m_off", "content": "hi"}, headers=headers)
            assert gone.status_code == 409 and _detail(gone)["code"] == "connector_offline"
            assert await store.get_device_command(user_id, "m_off") is None

    asyncio.run(scenario())


def test_a_command_the_device_confirms_first_goes_through_unchanged(mesh_router: RouterProcess, monkeypatch) -> None:
    """Quitting the app that holds a session: the device answers ``confirmation_required`` with its plan, and the
    follow-up names the plan in ``args``; each call is its own command with its own receipt."""

    plan = {
        "kind": "owner_release", "planId": "plan_1", "expiresAt": "2026-11-18T12:00:00.000Z", "appName": "Codex App",
        "processCount": 1, "releasesOtherSessions": True, "gracePeriodMs": 5000,
        "confirmArgs": ["--confirm", "plan_1"], "forceArgs": ["--confirm", "plan_1", "--force"],
        "cancelArgs": ["--cancel", "plan_1"],
    }

    def answer(request: dict[str, Any]) -> Any:
        args = (request["body"] or {}).get("args") or []
        if not args:
            return (200, {"command": "quit-codex-app", "ok": False, "code": "confirmation_required", "message": "sure?",
                          "result": {"executionState": "completed", "confirmation": plan}, "session": None,
                          "serverTime": "2026-11-18T10:00:00Z"})
        return (200, {"command": "quit-codex-app", "ok": True, "code": None, "message": "done",
                      "result": {"executionState": "completed", "status": "released"}, "session": None,
                      "serverTime": "2026-11-18T10:00:01Z"})

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, _device_id, device = await _session(app, client)
            state = device.state
            try:
                state.client_handler = answer
                url = f"{BASE}/runtime/commands"
                first = await client.post(url, json={"command": "quit-codex-app"}, headers=headers)
                assert first.status_code == 200, first.text
                assert first.json()["code"] == "confirmation_required"
                assert first.json()["result"]["confirmation"] == plan
                first_id = state.client_calls[-1]["command"]["commandId"]
                confirmed = await client.post(
                    url, json={"command": "quit-codex-app", "args": plan["forceArgs"]}, headers=headers
                )
                assert confirmed.status_code == 200, confirmed.text
                assert confirmed.json()["ok"] is True and confirmed.json()["result"]["status"] == "released"
                request = state.client_calls[-1]
                assert request["body"]["args"] == ["--confirm", "plan_1", "--force"]
                assert request["command"]["commandId"] != first_id
            finally:
                await device.stop()

    asyncio.run(scenario())


async def _known(state: Any, command_id: str) -> bool:
    return command_id in state.receipts


def test_terminal_stream_uses_client_subscribe(mesh_router: RouterProcess, monkeypatch) -> None:
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
        user = client.portal.call(lambda: store.create_user(user_id="user_sub", password="password-sub"))
        headers = {"Authorization": f"Bearer {create_user_access_token(user.userId)}"}
        created = client.post("/connectors", headers=headers, json={"name": "laptop"}).json()
        device_id, token = created["connector"]["id"], created["connectorToken"]
        device = client.portal.call(connect, client.app, device_id, token)

        def path(terminal_id: str = "trm_1") -> str:
            ticket = client.post(
                "/ws-ticket", headers=headers, json={"clientId": "web_sub", "scope": {"dashboard": True}}
            ).json()["ticket"]
            return f"/connectors/{device_id}/terminals-v2/{terminal_id}/stream?fromSeq=4&ticket={ticket}"

        try:
            state = device.state
            state.client_handler = lambda request: (200, {"ok": True, "result": {}})
            queue = state.client_terminal_items["trm_1"]
            queue.extend([
                {"type": "replay", "data": base64.b64encode(b"$ ").decode(), "seq": 4},
                {"type": "output", "data": base64.b64encode(b"ls\n").decode(), "seq": 5},
            ])
            with client.websocket_connect(path()) as ws:
                # The device's terminal messages, unchanged.
                assert ws.receive_json() == {"type": "replay", "data": "JCA=", "seq": 4}
                assert ws.receive_json() == {"type": "output", "data": "bHMK", "seq": 5}
                assert state.client_subscriptions[-1] == {"stream": "terminal", "terminalId": "trm_1", "fromSeq": 4}
                # Input and resizing are Client/call requests to the terminal's routes.
                ws.send_json({"type": "input", "data": "cHdkCg=="})
                ws.send_json({"type": "resize", "cols": 900, "rows": 50})
                ws.send_json({"type": "ping"})
                assert ws.receive_json() == {"type": "pong"}
                queue.append({"type": "exit", "exitCode": 0, "reason": "exit"})
                assert ws.receive_json() == {"type": "exit", "exitCode": 0, "reason": "exit"}
            calls = [(c["route"], c["path"], c["body"]) for c in state.client_calls]
            base = f"/api/v2/connectors/{device_id}/terminals-v2/trm_1"
            assert calls[:2] == [
                ("connector.terminals.write", f"{base}/write", {"dataBase64": "cHdkCg=="}),
                ("connector.terminals.resize", f"{base}/resize", {"cols": 500, "rows": 50}),
            ]

            # A terminal the device does not know: an error frame, then the socket closes.
            with client.websocket_connect(path("trm_none")) as ws:
                error = ws.receive_json()
                assert error["type"] == "error" and error["code"] == 404

            # The REST routes of the same family are forwarded too.
            listed = client.get(f"/connectors/{device_id}/terminals-v2", headers=headers)
            assert listed.status_code == 200 and state.client_calls[-1]["route"] == "connector.terminals.list"
        finally:
            with contextlib.suppress(Exception):
                client.portal.call(device.stop)


@pytest.mark.parametrize("route_id", sorted(r.id for r in ROUTES_BY_ID.values() if r.via == "call"))
def test_every_call_route_has_a_forwarding_stub(route_id: str) -> None:
    """Each ``Client/call`` route is named by the handler that forwards it."""

    api = Path(__file__).parents[1] / "agent_server" / "api"
    sources = "\n".join(path.read_text() for path in api.glob("*.py"))
    assert json.dumps(route_id) in sources, f"no handler forwards {route_id}"


def test_file_download_allocates_the_relay_and_previews_carry_the_verified_file(
    mesh_router: RouterProcess, monkeypatch
) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, device = await _session(app, client)
            state = device.state
            try:
                state.client_handler = lambda request: (200, {
                    "ok": True,
                    "result": {"name": "a.txt", "size": 3, "sha256": "abc", "mediaType": "text/plain", "path": "a.txt"},
                })
                response = await client.post(
                    f"/api/v2/connectors/{device_id}/fs/read", params={"root": "/repo"}, json={"path": "a.txt"},
                    headers=headers,
                )
                assert response.status_code == 200, response.text
                result = response.json()["result"]
                request = state.client_calls[-1]
                assert request["route"] == "connector.fs.read" and request["query"] == {"root": "/repo"}
                transfer = request["server"]["transfer"]
                assert transfer["transferId"] == result["transferId"] and transfer["token"] == result["token"]
                assert transfer["path"] == f"/api/v3/device/transfers/{result['transferId']}"
                assert transfer["downloadUrl"] == result["downloadUrl"]
                relayed = await app.state.fs_downloads.get(result["transferId"], result["token"])
                assert relayed.pushed and (relayed.name, relayed.size, relayed.media_type) == ("a.txt", 3, "text/plain")

                # A preview read: the Server verifies the token, then forwards the device's own route with the
                # file it opened.
                token = await client.post(
                    f"/api/v2/connectors/{device_id}/fs/preview-token", params={"root": "/repo"},
                    json={"path": "a.txt"}, headers=headers,
                )
                assert token.status_code == 200, token.text
                opened = await client.post(
                    "/api/v2/connectors/fs/preview-session", json={"previewToken": token.json()["previewToken"]}
                )
                assert opened.status_code == 200, opened.text
                access = opened.json()["previewAccessToken"]
                recorded = json.loads((FIXTURES / "device.fs.preview.readText.json").read_text())["response"]
                state.client_handler = lambda request: (200, recorded)
                text = await client.post("/api/v2/connectors/fs/preview/readText", json={"previewAccessToken": access})
                assert text.status_code == 200, text.text
                request = state.client_calls[-1]
                assert request["route"] == "connector.fs.readText"
                assert request["path"] == f"/api/v2/connectors/{device_id}/fs/readText"
                preview = request["server"]["preview"]
                assert preview["root"] == "/repo" and preview["path"].endswith("a.txt")
                assert request["body"]["path"] == preview["path"] and request["query"] == {"root": "/repo"}
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_the_relay_takes_an_upload_before_the_reader_arrives() -> None:
    from agent_server.infra.fs_downloads import FsDownloadRelayManager
    from agent_server.infra.redis_coordinator import RedisCoordinator

    async def scenario() -> None:
        relay = FsDownloadRelayManager(RedisCoordinator())
        transfer = await relay.create(
            connector_id="c1", root="/r", path="a", name="a", size=0, sha256="", media_type="x", pushed=True
        )

        async def chunks() -> Any:
            for part in (b"a" * 10, b"b" * 10, b"c"):
                yield part

        upload = asyncio.create_task(relay.upload(transfer_id=transfer.transfer_id, token=transfer.token, chunks=chunks()))
        await asyncio.sleep(0.05)
        assert upload.done() and upload.result() is True
        received = b"".join([part async for part in relay.stream(transfer_id=transfer.transfer_id, token=transfer.token)])
        assert received == b"a" * 10 + b"b" * 10 + b"c"

    asyncio.run(scenario())
