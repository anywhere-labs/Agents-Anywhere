from __future__ import annotations

import asyncio

import pytest
from starlette.websockets import WebSocketDisconnect
from test_backend_mvp import create_connector_and_session, make_client


def test_revocation_invalidates_previously_issued_access_token(tmp_path):
    client = make_client(tmp_path)
    connector_id, token, session_id, headers = create_connector_and_session(client)
    revoked = client.post(f"/connectors/{connector_id}/revoke", headers=headers)
    assert revoked.status_code == 200
    request = {
        "notifications": [
            {
                "method": "session.meta.upsert",
                "params": {
                    "sessionId": session_id,
                    "runtime": "codex",
                    "title": "stale write",
                },
            }
        ]
    }
    stale_headers = {"Authorization": f"Bearer {token}"}
    response = client.post("/connector/ingest", headers=stale_headers, json=request)
    assert response.status_code == 401
    assert asyncio.run(client.app.state.store.get_session(session_id)).title == "Demo"
    with (
        pytest.raises(WebSocketDisconnect) as closed,
        client.websocket_connect("/connector/ws", headers=stale_headers),
    ):
        pass
    assert closed.value.code == 1008
    new_secret = revoked.json()["connectorToken"]
    authenticated = client.post(
        "/connector/auth",
        headers={
            "Authorization": f"Connector {connector_id}:{new_secret}",
        },
    )
    assert authenticated.status_code == 200
    response = client.post(
        "/connector/ingest",
        headers={
            "Authorization": f"Bearer {authenticated.json()['accessToken']}",
        },
        json={"notifications": [{"method": "connector.heartbeat", "params": {}}]},
    )
    assert response.status_code == 200


def test_access_token_cannot_be_retargeted_to_another_connector(tmp_path):
    client = make_client(tmp_path)
    _, token, _, _ = create_connector_and_session(client)
    other, _, _, _ = create_connector_and_session(client)
    forged = f"{other}.{token.split('.', 1)[1]}"
    response = client.post(
        "/connector/ingest",
        headers={
            "Authorization": f"Bearer {forged}",
        },
        json={"notifications": [{"method": "connector.heartbeat", "params": {}}]},
    )
    assert response.status_code == 401


def test_failed_delete_keeps_revoked_tombstone_and_can_finish_on_retry(tmp_path):
    from agent_server.api.connectors import delete_connector

    client = make_client(tmp_path)
    connector_id, _, session_id, _ = create_connector_and_session(client)
    state = client.app.state

    async def run():
        owner = (await state.store.get_connector(connector_id)).userId
        original_disconnect = state.rpc.disconnect

        async def fail(*args, **kwargs):
            raise TimeoutError("owner did not acknowledge disconnect")

        kwargs = {
            "user_id": owner,
            "store": state.store,
            "manager": state.rpc,
            "broker": state.timeline_broker,
            "terminals": state.terminal_broker,
            "timeline_buffer": state.timeline_write_buffer,
            "runtime_state_cache": state.session_runtime_state_cache,
        }
        state.rpc.disconnect = fail
        with pytest.raises(TimeoutError):
            await delete_connector(connector_id, **kwargs)
        with pytest.raises(KeyError):
            await state.store.get_connector(connector_id)
        # Pending deletion retains the session IDs needed to retry all cleanup.
        assert await state.store.begin_connector_deletion(
            connector_id, user_id=owner
        ) == [session_id]
        state.rpc.disconnect = original_disconnect
        await delete_connector(connector_id, **kwargs)
        with pytest.raises(KeyError):
            await state.store.get_session(session_id)
        with pytest.raises(KeyError):
            await state.store.begin_connector_deletion(connector_id, user_id=owner)

    asyncio.run(run())


def test_runtime_deletion_fences_queued_and_retried_notifications(tmp_path):
    from agent_server.api.connector_ingress import _ConnectorNotificationPump
    from agent_server.core.models import ConnectorIngestRequest
    from agent_server.services.connector_ingest import ConnectorIngestService
    from agent_server.services.connector_notifications import (
        ConnectorNotificationService,
    )
    from agent_server.services.connector_realtime import ConnectorRealtimeService
    from runtime_fixtures import seed_runtime_inventory
    from test_runtime_config import _inventory

    client = make_client(tmp_path)
    connector_id, _, session_id, _ = create_connector_and_session(client)
    state = client.app.state

    async def run():
        await seed_runtime_inventory(
            state.store, connector_id, _inventory(status="stopped")
        )
        await state.store.set_device_runtime_config(connector_id, "codex", {})
        owner = (await state.store.get_connector(connector_id)).userId
        original = await state.store.get_session(session_id)
        realtime = ConnectorRealtimeService(
            state.shell_tasks, state.terminal_broker, state.terminal_stream_hub
        )
        service = ConnectorIngestService(
            state.store,
            ConnectorNotificationService(
                state.store, realtime, state.timeline_write_buffer
            ),
            state.timeline_broker,
            state.device_runtime_service,
            state.rpc,
            state.session_runtime_state_cache,
        )
        entered = asyncio.Event()

        class Blocked:
            async def handle_notification_message(self, **kwargs):
                entered.set()
                await asyncio.Event().wait()
                await service.handle_notification_message(**kwargs)

        class Socket:
            async def close(self, **kwargs):
                pass

        connection = await state.rpc.register(connector_id, Socket())
        pump = _ConnectorNotificationPump(
            connector_id, Blocked(), runtime_epochs={"codex": 0}
        )
        connection.abort_notifications = pump.abort
        connection.update_runtime_epoch = pump.update_runtime_epoch
        pump.start()
        notification = {
            "method": "session.meta.upsert",
            "params": {
                "sessionId": session_id,
                "runtime": "codex",
                "runtimeId": "codex",
                "externalSessionId": original.externalSessionId,
                "cwd": original.cwd,
                "title": "stale",
            },
        }
        pump.enqueue_message(notification)
        await entered.wait()
        runtime = await asyncio.wait_for(
            state.device_runtime_service.delete_config(
                connector_id, "codex", user_id=owner
            ),
            2,
        )
        assert not runtime.configured and runtime.ingressEpoch == 1
        await pump.flush()
        assert pump.obsolete == 1
        with pytest.raises(KeyError):
            await state.store.get_session(session_id)
        await state.store.set_device_runtime_config(connector_id, "codex", {})
        # An HTTP outbox from before deletion remains obsolete after reconfiguration.
        result = await service.ingest(
            connector_id=connector_id,
            payload=ConnectorIngestRequest(notifications=[notification]),
        )
        assert result.accepted == 0 and result.rejected[0].code == "obsolete_runtime"
        notification["params"]["runtimeEpoch"] = 1
        notification["params"]["title"] = "new runtime"
        result = await service.ingest(
            connector_id=connector_id,
            payload=ConnectorIngestRequest(notifications=[notification]),
        )
        assert result.accepted == 1 and not result.rejected
        assert (await state.store.get_session(session_id)).title == "new runtime"
        await pump.close()
        await state.rpc.unregister(connector_id, connection)

    asyncio.run(run())


def test_pending_deletion_is_resumed_without_purging_legacy_revoked_rows(tmp_path):
    from agent_server.infra.db import connectors as connectors_t
    from sqlalchemy import update

    client = make_client(tmp_path)
    connector_id, _, session_id, _ = create_connector_and_session(client)
    legacy_id, _, _, _ = create_connector_and_session(client)
    state = client.app.state

    async def run():
        owner = (await state.store.get_connector(connector_id)).userId
        async with state.store.engine.begin() as conn:
            await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == legacy_id)
                .values(revoked=1)
            )
        await state.store.begin_connector_deletion(connector_id, user_id=owner)
        assert await state.store.pending_connector_deletions() == [
            (connector_id, owner)
        ]
        await state.connector_deletion_recovery.run_once()
        with pytest.raises(KeyError):
            await state.store.get_session(session_id)
        # The recovery worker must never reinterpret an old credential state as deletion consent.
        await state.store.delete_connector(legacy_id, user_id=owner)

    asyncio.run(run())
