"""v3 read-through: snapshot, timeline pages and event recovery come from the device (D1).

Real Server app (in-process ASGI), real MeshCall Router, fake device.
"""

from __future__ import annotations

import asyncio
import base64
import json
import zlib

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

from agent_server.core.device_meshcall import StreamChunk
from agent_server.services.device_reads import merge_snapshot_chunks
from scripts.v3_fake_device import connect_device


async def _device_with_session(app, client, session_id: str, items: int):
    headers, device_id, token = await user_and_device(app, client)
    device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
    fake = device.state.session(session_id)
    for order in range(1, items + 1):
        fake.append(timeline_item(session_id, order, f"line {order}"))
    pushed = device.state.push_outbox("session.summary", summary(session_id, fake.head_seq))
    await eventually(lambda: acked(device, pushed.oid))
    return headers, device_id, device


def test_reads_come_from_the_online_device(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            headers, _device_id, device = await _device_with_session(app, client, "sess_r1", 5)
            try:
                snapshot = await client.get("/api/v2/sessions/sess_r1/snapshot?limit=3", headers=headers)
                assert snapshot.status_code == 200, snapshot.text
                body = snapshot.json()
                assert body["historySource"] == "live" and body["deviceOffline"] is False
                assert [item["id"] for item in body["timeline"]["items"]] == ["tl_3", "tl_4", "tl_5"]
                assert body["timeline"]["nextSeq"] == 5 and body["timeline"]["hasMore"] is True
                assert body["eventCursor"] == "seq:5"
                assert body["session"]["title"] == "Fix the build"
                assert body["session"]["goalState"] == "active"
                assert body["session"]["displayDevice"]["mode"] == "plain"

                latest = await client.get("/api/v2/sessions/sess_r1/timeline?limit=2", headers=headers)
                assert latest.status_code == 200, latest.text
                assert [item["id"] for item in latest.json()["items"]] == ["tl_4", "tl_5"]
                assert latest.json()["nextSeq"] == 5 and latest.json()["deviceOffline"] is False

                older = await client.get(
                    "/api/v2/sessions/sess_r1/timeline?mode=history&beforeOrderSeq=4&limit=2", headers=headers
                )
                assert [item["id"] for item in older.json()["items"]] == ["tl_2", "tl_3"]

                events = await client.get("/api/v2/sessions/sess_r1/events?after=seq:3", headers=headers)
                assert events.status_code == 200, events.text
                assert [event["sequence"] for event in events.json()["events"]] == [4, 5]
                assert events.json()["nextCursor"] == "seq:5"

                # Concurrent first screens of one session share one device read.
                device.state.read_delay = 0.5
                before = device.state.calls.count("snapshot")
                answers = await asyncio.gather(
                    *(client.get("/api/v2/sessions/sess_r1/snapshot", headers=headers) for _ in range(4))
                )
                assert all(answer.status_code == 200 for answer in answers)
                assert device.state.calls.count("snapshot") - before == 1
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
            headers, _device_id, device = await _device_with_session(app, client, "sess_r3", 2)
            try:
                device.state.read_delay = 3
                snapshot = await client.get("/api/v2/sessions/sess_r3/snapshot", headers=headers)
                assert snapshot.status_code == 504, snapshot.text
                assert snapshot.json()["detail"]["code"] == "device_read_timeout"
                page = await client.get("/api/v2/sessions/sess_r3/timeline", headers=headers)
                assert page.status_code == 504
                assert page.json()["detail"]["code"] == "device_read_timeout"
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
