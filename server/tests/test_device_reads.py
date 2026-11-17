"""v3 read-through: snapshot, timeline pages and event recovery come from the device (D1).

Real Server app (in-process ASGI), real MeshCall Router, fake device.
"""

from __future__ import annotations

import asyncio
import base64
import json
import zlib
from pathlib import Path
from typing import Any

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

from agent_server.core.auth import create_user_access_token
from agent_server.core.device_meshcall import StreamChunk
from agent_server.services.device_reads import DeviceReadService, merge_snapshot_chunks
from scripts.v3_fake_device import connect_device

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "client_routes"


async def _device_with_session(app, client, session_id: str, items: int):
    headers, device_id, token = await user_and_device(app, client)
    device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
    fake = device.state.session(session_id)
    for order in range(1, items + 1):
        fake.append(timeline_item(session_id, order, f"line {order}"))
    pushed = device.state.push_outbox("session.summary", summary(session_id, fake.head_seq))
    await eventually(lambda: acked(device, pushed.oid))
    return headers, device_id, device


def _page(session_id: str, orders: list[int], *, next_seq: int, has_more: bool = False) -> dict[str, Any]:
    return {
        "sessionId": session_id,
        "items": [{**timeline_item(session_id, order, f"line {order}"), "updatedSeq": order} for order in orders],
        "nextSeq": next_seq,
        "hasMore": has_more,
        "serverTime": "2026-11-17T10:00:00Z",
    }


def _device_reads(session_id: str) -> Any:
    """The device's answers to the session read routes."""

    events = json.loads((FIXTURES / "session.events.json").read_text())["response"]

    def answer(request: dict[str, Any]) -> Any:
        route = request["route"]
        if route == "session.snapshot":
            return 200, {
                "session": {"id": "the device's own view"},
                "timeline": _page(session_id, [3, 4, 5], next_seq=5, has_more=True),
                "notices": [],
                "eventCursor": "seq:5",
                "serverTime": "2026-11-17T10:00:00Z",
            }
        if route == "session.timeline":
            return 200, _page(session_id, [4, 5], next_seq=5)
        if route == "session.events":
            return 200, events
        return 404, {"detail": {"code": "route_not_found", "message": route}}

    return answer


def test_reads_are_forwarded_to_the_online_device(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, _device_id, device = await _device_with_session(app, client, "sess_r1", 5)
            state = device.state
            base = "/api/v2/sessions/sess_r1"
            try:
                state.client_handler = _device_reads("sess_r1")

                # The device's content with the Server's session view, capabilities and catalogs.
                snapshot = await client.get(f"{base}/snapshot?limit=3", headers=headers)
                assert snapshot.status_code == 200, snapshot.text
                body = snapshot.json()
                assert body["historySource"] == "live" and body["deviceOffline"] is False
                assert [item["id"] for item in body["timeline"]["items"]] == ["tl_3", "tl_4", "tl_5"]
                assert body["timeline"]["nextSeq"] == 5 and body["timeline"]["hasMore"] is True
                assert body["eventCursor"] == "seq:5"
                assert body["session"]["id"] == "sess_r1" and body["session"]["title"] == "Fix the build"
                assert body["session"]["goalState"] == "active"
                assert body["session"]["displayDevice"]["mode"] == "plain"
                assert "capabilities" in body["effectiveCapabilities"]
                request = state.client_calls[-1]
                assert request["route"] == "session.snapshot" and request["path"] == f"{base}/snapshot"
                assert request["query"] == {"limit": "3"} and request["server"] is None and request["command"] is None

                latest = await client.get(f"{base}/timeline?limit=2", headers=headers)
                assert latest.status_code == 200, latest.text
                assert [item["id"] for item in latest.json()["items"]] == ["tl_4", "tl_5"]
                assert latest.json()["nextSeq"] == 5 and latest.json()["deviceOffline"] is False

                older = await client.get(f"{base}/timeline?mode=history&beforeOrderSeq=4&limit=2", headers=headers)
                assert older.status_code == 200, older.text
                request = state.client_calls[-1]
                assert request["route"] == "session.timeline"
                assert request["query"] == {"mode": "history", "beforeOrderSeq": "4", "limit": "2"}

                events = await client.get(f"{base}/events?after=seq:3", headers=headers)
                assert events.status_code == 200, events.text
                assert events.json()["events"] and events.json()["deviceOffline"] is False
                request = state.client_calls[-1]
                assert request["route"] == "session.events" and request["query"] == {"after": "seq:3"}

                # Concurrent first screens of one session share one device read.
                state.client_delay = 0.5
                before = len(state.client_calls)
                answers = await asyncio.gather(*(client.get(f"{base}/snapshot", headers=headers) for _ in range(4)))
                assert all(answer.status_code == 200 for answer in answers)
                assert len(state.client_calls) - before == 1
                state.client_delay = 0

                # Only the owner's sessions reach the device.
                other = await app.state.store.create_user(user_id="user_other", password="password-other")
                stranger = {"Authorization": f"Bearer {create_user_access_token(other.userId)}"}
                before = len(state.client_calls)
                for route in ("snapshot", "timeline", "events"):
                    denied = await client.get(f"{base}/{route}", headers=stranger)
                    assert denied.status_code == 404, denied.text
                unknown = await client.get("/api/v2/sessions/sess_none/timeline", headers=headers)
                assert unknown.status_code == 404
                assert len(state.client_calls) == before

                # A device body that is not a snapshot is the device's fault.
                state.client_handler = lambda request: (200, {"timeline": {"items": "nope"}})
                invalid = await client.get(f"{base}/snapshot", headers=headers)
                assert invalid.status_code == 502 and invalid.json()["detail"]["code"] == "device_response_invalid"
                state.client_handler = lambda request: (200, {"runtimeCapabilities": {"capabilities": "nope"}})
                invalid = await client.get(f"{base}/snapshot", headers=headers)
                assert invalid.status_code == 502 and invalid.json()["detail"]["code"] == "device_response_invalid"
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_offline_device_reads_return_directory_facts_only(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, device = await _device_with_session(app, client, "sess_r2", 3)
            await device.stop()
            await eventually(lambda: offline(app.state.rpc, device_id))

            snapshot = await client.get("/api/v2/sessions/sess_r2/snapshot", headers=headers)
            assert snapshot.status_code == 200, snapshot.text
            body = snapshot.json()
            assert body["deviceOffline"] is True and body["historySource"] == "unavailable"
            assert body["timeline"]["items"] == [] and body["timeline"]["nextSeq"] == 3
            assert body["eventCursor"] == "seq:0"
            assert body["session"]["title"] == "Fix the build"
            assert body["session"]["connectorStatus"] == "offline"

            page = await client.get("/api/v2/sessions/sess_r2/timeline", headers=headers)
            assert page.status_code == 200
            assert page.json()["deviceOffline"] is True and page.json()["items"] == []

            events = await client.get("/api/v2/sessions/sess_r2/events?after=seq:2", headers=headers)
            assert events.status_code == 200
            assert events.json() == {**events.json(), "events": [], "nextCursor": "seq:2", "deviceOffline": True}

    asyncio.run(scenario())


def test_a_device_that_does_not_answer_in_time_is_not_offline(mesh_router: RouterProcess, monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SERVER_DEVICE_READ_TIMEOUT_SECONDS", "1")

    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, device_id, device = await _device_with_session(app, client, "sess_r3", 2)
            try:
                device.state.client_handler = _device_reads("sess_r3")
                device.state.client_delay = 3
                snapshot = await client.get("/api/v2/sessions/sess_r3/snapshot", headers=headers)
                assert snapshot.status_code == 504, snapshot.text
                assert snapshot.json()["detail"]["code"] == "device_read_timeout"
                page = await client.get("/api/v2/sessions/sess_r3/timeline", headers=headers)
                assert page.status_code == 504
                assert page.json()["detail"]["code"] == "device_read_timeout"
                assert await app.state.rpc.is_online(device_id)
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_snapshot_chunks_merge_in_order_and_inflate() -> None:
    first = {"timeline": {"items": [{"id": "a"}], "hasMore": True}, "notices": []}
    second = {"timeline": {"items": [{"id": "b"}], "nextSeq": 9}, "eventCursor": "seq:9"}
    packed = base64.b64encode(zlib.compress(json.dumps(second).encode())).decode()
    body = merge_snapshot_chunks([StreamChunk(seq=1, chunk=packed, end=True), StreamChunk(seq=0, chunk=first)])
    assert body == {
        "timeline": {"items": [{"id": "a"}, {"id": "b"}], "hasMore": True, "nextSeq": 9},
        "notices": [],
        "eventCursor": "seq:9",
    }


def test_snapshot_chunks_join_json_text_slices() -> None:
    body = {"timeline": {"items": [{"id": "a"}, {"id": "b"}], "nextSeq": 9}, "eventCursor": "seq:9", "notices": []}
    text = json.dumps(body)
    slices = [text[:7], text[7:20], text[20:]]
    chunks = [StreamChunk(seq=index, chunk=part, end=index == 2) for index, part in enumerate(slices)]
    assert merge_snapshot_chunks(list(reversed(chunks))) == body
    assert merge_snapshot_chunks([StreamChunk(seq=0, chunk=text, end=True)]) == body


def _reads() -> DeviceReadService:
    return DeviceReadService(None, None, None)  # type: ignore[arg-type]


def test_single_flight_survives_the_first_caller_being_cancelled() -> None:
    async def scenario() -> None:
        reads = _reads()
        release = asyncio.Event()
        calls: list[int] = []

        async def read() -> dict:
            calls.append(1)
            await release.wait()
            return {"ok": True}

        key = ("snapshot", "conn_1", "sess_1")
        first = asyncio.create_task(reads._single_flight(key, read))
        await asyncio.sleep(0)
        second = asyncio.create_task(reads._single_flight(key, read))
        await asyncio.sleep(0)
        first.cancel()
        await asyncio.sleep(0)
        assert first.cancelled()
        assert not second.done()
        release.set()
        assert await second == {"ok": True}
        assert calls == [1]
        assert reads._flights == {}

    asyncio.run(scenario())


def test_single_flight_cancels_the_read_when_nobody_waits() -> None:
    async def scenario() -> None:
        reads = _reads()
        started = asyncio.Event()
        cancelled: list[bool] = []

        async def read() -> dict:
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.append(True)
                raise
            return {}

        key = ("snapshot", "conn_1", "sess_1")
        first = asyncio.create_task(reads._single_flight(key, read))
        second = asyncio.create_task(reads._single_flight(key, read))
        await started.wait()
        first.cancel()
        second.cancel()
        await asyncio.gather(first, second, return_exceptions=True)
        await asyncio.sleep(0)
        assert cancelled == [True]
        assert reads._flights == {}

        # A later caller starts a new read.
        async def fresh() -> dict:
            return {"fresh": True}

        assert await reads._single_flight(key, fresh) == {"fresh": True}

    asyncio.run(scenario())


def test_single_flight_shares_a_failure() -> None:
    async def scenario() -> None:
        reads = _reads()
        release = asyncio.Event()

        async def read() -> dict:
            await release.wait()
            raise RuntimeError("device answered with an error")

        key = ("snapshot", "conn_1", "sess_1")
        waiters = [asyncio.create_task(reads._single_flight(key, read)) for _ in range(2)]
        await asyncio.sleep(0)
        release.set()
        results = await asyncio.gather(*waiters, return_exceptions=True)
        assert all(isinstance(result, RuntimeError) for result in results)
        assert reads._flights == {}

    asyncio.run(scenario())
