from __future__ import annotations

import asyncio
from contextvars import Context

import pytest

from agent_server.api import sessions
from agent_server.infra.db.migrations import upgrade_database
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.session_runtime_state_cache import SessionRuntimeStateCache
from agent_server.services.timeline_write_buffer import TimelineWriteBuffer


@pytest.mark.anyio
@pytest.mark.parametrize("operation", ["enable", "disable", "refresh"])
@pytest.mark.parametrize("event_during_query", [False, True])
async def test_session_refresh_allows_dsh_source_callback(
    tmp_path, operation, event_during_query
):
    db_path = tmp_path / "session-refresh.sqlite3"
    upgrade_database(sqlite_path=db_path)
    store = Store(db_path)
    await store.create_user(user_id="user_1", password="test-password")
    connector, _, _ = await store.create_connector(name="DSH", user_id="user_1")
    project = await store.create_project(
        user_id="user_1", connector_id=connector.id,
        name="DSH", workspace_path="/repo",
    )
    session = await store.create_session(
        connector_id=connector.id,
        project_id=project.id,
        user_id="user_1",
        runtime="dsh",
        external_session_id="dsh-session",
        title="DSH lock regression",
        cwd="/repo",
    )
    await store.set_takeover(session.id, operation == "disable")
    coordinator = RedisCoordinator()
    broker = TimelineBroker(coordinator)
    buffer = TimelineWriteBuffer(store, broker, coordinator)
    cache = SessionRuntimeStateCache()
    published = []
    rpc_methods = []

    async def record_publish(_session_id, payload):
        published.append(payload)

    broker.publish = record_publish

    class DshConnector:
        async def is_online(self, _connector_id):
            return True

        async def request(self, _connector_id, method, params, *, timeout):
            rpc_methods.append(method)
            assert params["sessionId"] == session.id
            if method == "session.state":
                # Model the separate HTTP ingest request DSH awaits before its
                # RPC response. It must not inherit the caller's reentrant fence.
                callback = asyncio.create_task(
                    store.update_session_source_state(
                        session.id,
                        availability="available",
                        reason=None,
                        observed_at=None,
                        observation_origin="operation",
                    ),
                    context=Context(),
                )
                try:
                    await asyncio.wait_for(callback, timeout=1)
                except TimeoutError:
                    pytest.fail("DSH source callback blocked by the RPC caller's lock")
                return {"state": {"runtime": "dsh", "status": "running"}}
            assert method == "session.capabilities"
            if event_during_query:
                latest = await store.set_session_status(session.id, "idle")
                state = await cache.get(session.id)
                assert state is not None
                await cache.put(state.model_copy(update={
                    "status": "idle", "updatedSeq": latest.updatedSeq,
                }))
            return {"capabilitySet": {"revision": 1, "capabilities": [{
                "capabilityId": "session.send_message",
                "scope": "session",
                "runtime": "dsh",
                "sessionId": session.id,
                "supported": True,
                "available": True,
                "allowed": True,
            }]}}

    connector_rpc = DshConnector()
    try:
        if operation == "refresh":
            await sessions._publish_session_protocol_update(
                store, broker, connector_rpc, cache, session.id,
            )
        else:
            handler = (
                sessions.enable_takeover if operation == "enable"
                else sessions.disable_takeover
            )
            response = await handler(
                session_id=session.id,
                user_id="user_1",
                db=store,
                broker=broker,
                manager=connector_rpc,
                runtime_state_cache=cache,
                timeline_write_buffer=buffer,
            )
            assert response.session.takeover is (operation == "enable")

        assert rpc_methods == ["session.state", "session.capabilities"]
        latest = await store.get_session(session.id)
        expected_status = "idle" if event_during_query else "running"
        assert latest.status == expected_status
        assert published[-1]["session"]["takeover"] is (operation == "enable")
        assert published[-1]["runtimeState"]["status"] == expected_status
        assert published[-1]["nextSeq"] == latest.updatedSeq
        sequences = [payload["nextSeq"] for payload in published]
        assert sequences == sorted(sequences)
        capability = next(
            item for item in published[-1]["capabilitySet"]["capabilities"]
            if item["capabilityId"] == "session.send_message"
        )
        assert capability["allowed"] is (operation == "enable")
    finally:
        await buffer.close()
        await store.close()
