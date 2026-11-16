"""On-demand ``Sessions/watch`` and its fan-out (real Router, fake device)."""

from __future__ import annotations

import asyncio
import json

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

from agent_server.api.sessions import _client_protocol_at_least
from agent_server.core.events import events_from_invalidation
from scripts.v3_fake_device import connect_device


async def _next_events(queue: asyncio.Queue, timeout: float = 10.0) -> list:
    message = await asyncio.wait_for(queue.get(), timeout=timeout)
    return events_from_invalidation(json.loads(str(message)))


async def _next_of_type(queue: asyncio.Queue, event_type: str, timeout: float = 10.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_running_loop().time()
        for event in await _next_events(queue, max(remaining, 0.01)):
            if event.type == event_type:
                return event


def test_watch_opens_with_the_first_subscriber_and_fans_out(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            _headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            hub = app.state.session_watch
            try:
                pushed = device.state.push_outbox("session.summary", summary("sess_w1", 0))
                await eventually(lambda: acked(device, pushed.oid))
                queue = await app.state.timeline_broker.register("sess_w1")

                await hub.add_subscriber("sess_w1", device_id)
                catchup = await _next_of_type(queue, "session.catchup_required")
                assert catchup.payload == {"sessionId": "sess_w1", "reason": "subscription_restored"}

                async def watching() -> bool:
                    return bool(device.state.session("sess_w1").watchers)

                await eventually(watching)
                # A second local subscriber shares the stream.
                await hub.add_subscriber("sess_w1", device_id)
                assert device.state.calls.count("watch") == 1

                device.state.session("sess_w1").append(timeline_item("sess_w1", 1, "hello"))
                created = await _next_of_type(queue, "timeline.item_created")
                assert created.sequence == 1
                # The ceiling was written before the item went out.
                assert await app.state.store.session_seq_ceiling("sess_w1") == 1 + 1024

                # The last subscriber leaving stops the stream on the next sweep.
                await hub.remove_subscriber("sess_w1")
                await hub.remove_subscriber("sess_w1")
                await hub.sweep_device(device_id)
                assert hub.watched(device_id) == set()

                async def unwatched() -> bool:
                    return not device.state.session("sess_w1").watchers

                await eventually(unwatched)
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_watches_reopen_after_the_device_reconnects(mesh_router: RouterProcess, monkeypatch) -> None:
    async def scenario() -> None:
        async with server(mesh_router, monkeypatch) as (app, client):
            _headers, device_id, token = await user_and_device(app, client)
            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            hub = app.state.session_watch
            pushed = device.state.push_outbox("session.summary", summary("sess_w2", 0))
            await eventually(lambda: acked(device, pushed.oid))
            queue = await app.state.timeline_broker.register("sess_w2")
            await hub.add_subscriber("sess_w2", device_id)
            assert (await _next_of_type(queue, "session.catchup_required")).payload["reason"] == "subscription_restored"

            await device.stop()
            await eventually(lambda: offline(app.state.rpc, device_id))
            assert hub.watched(device_id) == set()

            device, _welcome, _access = await connect_device(client, connector_id=device_id, connector_token=token)
            try:
                catchup = await _next_of_type(queue, "session.catchup_required")
                assert catchup.payload["reason"] == "device_reconnected"
                assert hub.watched(device_id) == {"sess_w2"}

                async def watching() -> bool:
                    return bool(device.state.session("sess_w2").watchers)

                await eventually(watching)
                device.state.session("sess_w2").append(timeline_item("sess_w2", 1, "after reconnect"))

                assert (await _next_of_type(queue, "timeline.item_created")).payload["item"]["id"] == "tl_1"
            finally:
                await device.stop()

    asyncio.run(scenario())


def test_client_protocol_gate() -> None:
    assert _client_protocol_at_least("1.2", (1, 2))
    assert _client_protocol_at_least("2.0", (1, 2))
    assert not _client_protocol_at_least("1.1", (1, 2))
    assert not _client_protocol_at_least(None, (1, 2))
    assert not _client_protocol_at_least("x", (1, 2))


def _catchup_message(session_id: str, reason: str) -> dict:
    return {
        "sessionId": session_id,
        "events": [
            {
                "eventId": f"evt_catchup_{reason}",
                "sequence": 0,
                "cursor": "seq:0",
                "type": "session.catchup_required",
                "sessionId": session_id,
                "emittedAt": "2026-11-16T10:00:00Z",
                "payload": {"sessionId": session_id, "reason": reason},
            }
        ],
    }


def test_session_socket_registers_interest_and_gates_catchup_by_protocol() -> None:
    from conftest import make_test_client
    from starlette.websockets import WebSocketDisconnect

    from agent_server.core.auth import create_user_access_token

    with make_test_client() as client:
        app = client.app
        store = app.state.store
        user = client.portal.call(lambda: store.create_user(user_id="user_ws", password="password-ws"))
        headers = {"Authorization": f"Bearer {create_user_access_token(user.userId)}"}
        created = client.post("/connectors", headers=headers, json={"name": "laptop"}).json()
        device_id = created["connector"]["id"]
        client.post(
            "/projects", headers=headers, json={"connectorId": device_id, "name": "repo", "workspacePath": "/repo"}
        ).raise_for_status()
        client.portal.call(lambda: store.set_connector_link_contract(device_id, "device-meshcall/1.0"))
        session = client.portal.call(
            lambda: store.upsert_connector_session(
                connector_id=device_id,
                session_id="sess_ws",
                runtime="codex",
                runtime_id="codex",
                external_session_id="thr_ws",
                title="t",
                cwd="/repo",
                last_activity_at=None,
            )
        )
        hub = app.state.session_watch
        broker = app.state.timeline_broker

        def ticket() -> str:
            return client.post(
                "/ws-ticket", headers=headers, json={"clientId": "web_ws", "scope": {"sessionId": session.id}}
            ).json()["ticket"]

        # Protocol 1.2 clients get the event.
        with client.websocket_connect(f"/sessions/{session.id}/ws?ticket={ticket()}&protocol=1.2") as ws:
            assert ws.receive_json()["type"] == "session.subscribed"
            assert hub._local[session.id].count == 1
            client.portal.call(broker.publish, session.id, _catchup_message(session.id, "device_reconnected"))
            event = ws.receive_json()
            assert event["type"] == "session.catchup_required"
            assert event["payload"]["reason"] == "device_reconnected"
        assert session.id not in hub._local

        # Older clients are disconnected with a reconnectable code instead.
        with client.websocket_connect(f"/sessions/{session.id}/ws?ticket={ticket()}") as ws:
            assert ws.receive_json()["type"] == "session.subscribed"
            client.portal.call(broker.publish, session.id, _catchup_message(session.id, "device_reconnected"))
            try:
                ws.receive_json()
            except WebSocketDisconnect as exc:
                assert exc.code == 1013
            else:
                raise AssertionError("an old client kept its socket")


class _StubLinks:
    def __init__(self, held: dict[str, str]) -> None:
        self.held = held

    def local_connection(self, device_id: str) -> str | None:
        return self.held.get(device_id)

    def held_devices(self) -> list[str]:
        return list(self.held)


class _StubMesh:
    def __init__(self) -> None:
        self.opened: list[tuple[str, int]] = []
        self.closed: list[str] = []

    async def stream(self, device_id, route, request, item_type, *, connection_id=None, **_kwargs):
        self.opened.append((request.sessionId, request.afterSeq))
        try:
            await asyncio.Event().wait()
            yield  # pragma: no cover
        finally:
            self.closed.append(request.sessionId)


class _StubStore:
    async def session_directory_fields(self, session_id: str) -> dict:
        return {"headSeq": 7, "seqCeiling": 0}

    async def raise_session_seq_ceiling(self, session_id: str, ceiling: int) -> int:
        return ceiling


def test_interest_crosses_workers_through_redis() -> None:
    from fakeredis import FakeServer
    from fakeredis.aioredis import FakeRedis

    from agent_server.infra.redis_coordinator import RedisCoordinator
    from agent_server.infra.session_watch import SessionWatchHub

    async def scenario() -> None:
        server_ = FakeServer()

        def coordinator() -> RedisCoordinator:
            return RedisCoordinator(prefix="test-watch", client=FakeRedis(server=server_, decode_responses=True))

        published: list[tuple[str, dict]] = []

        async def publish(session_id: str, payload: dict) -> None:
            published.append((session_id, payload))

        mesh = _StubMesh()
        holder = SessionWatchHub(
            mesh, _StubLinks({"dev_1": "lc_1"}), coordinator(), _StubStore(), publish, worker_id="w_holder"
        )
        viewer = SessionWatchHub(
            _StubMesh(), _StubLinks({}), coordinator(), _StubStore(), publish, worker_id="w_viewer"
        )
        await holder.start()
        await viewer.start()
        try:
            await asyncio.sleep(0.1)  # let the wake listener subscribe
            await viewer.add_subscriber("sess_x", "dev_1")
            await eventually(lambda: _async(holder.watched("dev_1") == {"sess_x"}))
            await eventually(lambda: _async(mesh.opened == [("sess_x", 7)]))
            assert published and published[0][1]["events"][0]["type"] == "session.catchup_required"

            # A worker that dies leaves a field that expires; the holder drops it on its sweep.
            client = viewer._coordinator.client
            await client.hset(viewer._subs_key("sess_x"), "w_viewer", 1)
            await holder.sweep_device("dev_1")
            assert holder.watched("dev_1") == set()
            assert not await client.exists(viewer._device_key("dev_1")) or not await client.sismember(
                viewer._device_key("dev_1"), "sess_x"
            )
            await eventually(lambda: _async(mesh.closed == ["sess_x"]))
        finally:
            await viewer.close()
            await holder.close()

    asyncio.run(scenario())


async def _async(value: bool) -> bool:
    return value
