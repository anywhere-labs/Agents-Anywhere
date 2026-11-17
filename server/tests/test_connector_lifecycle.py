from __future__ import annotations

import asyncio

import pytest
from conftest import ApiV2TestClient
from starlette.websockets import WebSocketDisconnect
from test_backend_mvp import create_connector_and_session, make_client

from agent_server.app import create_app


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


def test_transport_disconnect_preserves_connector_authentication(tmp_path):
    client = make_client(tmp_path)
    connector_id, token, _, _ = create_connector_and_session(client)

    async def run():
        class Socket:
            async def close(self, **kwargs):
                pass

        for _ in range(2):
            connection = await client.app.state.rpc.register(connector_id, Socket())
            await client.app.state.rpc.unregister(connector_id, connection)
            assert await client.app.state.store.authenticate_connector_access(token) == connector_id

    asyncio.run(run())
    response = client.post(
        "/connector/ingest", headers={"Authorization": f"Bearer {token}"},
        json={"notifications": [{"method": "connector.heartbeat", "params": {}}]},
    )
    assert response.status_code == 200, response.text


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
            "runtime_state_cache": state.session_runtime_state_cache,
            "links": state.device_link,
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


def test_pending_deletion_is_resumed_without_purging_legacy_revoked_rows(tmp_path):
    from sqlalchemy import update

    from agent_server.infra.db import connectors as connectors_t

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


def _ingest_runtime_title(client, token, session_id, title):
    return client.post(
        "/connector/ingest",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "notifications": [
                {
                    "method": "session.meta.upsert",
                    "params": {
                        "sessionId": session_id,
                        "runtime": "codex",
                        "title": title,
                    },
                }
            ]
        },
    )


def test_manual_rename_survives_connector_title_sync(tmp_path):
    client = make_client(tmp_path)
    _, token, session_id, headers = create_connector_and_session(client)

    renamed = client.patch(
        f"/sessions/{session_id}/meta",
        headers=headers,
        json={"title": "renamed by hand"},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["session"]["title"] == "renamed by hand"

    response = _ingest_runtime_title(client, token, session_id, "thread title")
    assert response.status_code == 200, response.text
    assert asyncio.run(client.app.state.store.get_session(session_id)).title == (
        "renamed by hand"
    )


def test_connector_title_still_applies_without_manual_rename(tmp_path):
    client = make_client(tmp_path)
    _, token, session_id, _ = create_connector_and_session(client)

    response = _ingest_runtime_title(client, token, session_id, "thread title")
    assert response.status_code == 200, response.text
    assert asyncio.run(client.app.state.store.get_session(session_id)).title == (
        "thread title"
    )


def test_connector_resync_upsert_keeps_manual_title(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)

    renamed = client.patch(
        f"/sessions/{session_id}/meta",
        headers=headers,
        json={"title": "renamed by hand"},
    )
    assert renamed.status_code == 200, renamed.text

    async def run():
        return await client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id=session_id,
            runtime="codex",
            runtime_id="codex",
            external_session_id=f"thr_{connector_id}_demo",
            title="thread title",
        )

    assert asyncio.run(run()).title == "renamed by hand"


def test_manual_title_survives_archive_restore_and_application_restart(tmp_path):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)
    renamed = client.patch(
        f"/sessions/{session_id}/meta",
        headers=headers,
        json={"title": "  user-owned title  "},
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["session"]["title"] == "user-owned title"

    for archived in (True, False):
        response = client.patch(
            f"/sessions/{session_id}/meta",
            headers=headers,
            json={"archived": archived},
        )
        assert response.status_code == 200, response.text

    # Reopen the existing database; make_client would replace it with a fixture.
    restarted = ApiV2TestClient(create_app())
    snapshot = asyncio.run(
        restarted.app.state.store.update_session_snapshot(
            session_id=session_id,
            title="connector title after restart",
        )
    )
    assert snapshot.title == "user-owned title"


def test_connector_rescan_alias_keeps_manual_title(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)
    renamed = client.patch(
        f"/sessions/{session_id}/meta",
        headers=headers,
        json={"title": "user-owned title"},
    )
    assert renamed.status_code == 200, renamed.text

    async def rescan():
        return await client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id="new-scan-alias",
            runtime="codex",
            runtime_id="codex",
            external_session_id=f"thr_{connector_id}_demo",
            title="title from rescanned inventory",
            cwd="/repo",
        )

    session = asyncio.run(rescan())
    assert session.id == session_id
    assert session.title == "user-owned title"


def test_explicit_same_title_rename_claims_title_ownership(tmp_path):
    client = make_client(tmp_path)
    _, token, session_id, headers = create_connector_and_session(client)
    blank = client.patch(
        f"/sessions/{session_id}/meta",
        headers=headers,
        json={"title": "  "},
    )
    assert blank.status_code == 422, blank.text
    renamed = client.patch(
        f"/sessions/{session_id}/meta",
        headers=headers,
        json={"title": "Demo"},
    )
    assert renamed.status_code == 200, renamed.text
    synced = _ingest_runtime_title(client, token, session_id, "runtime changed")
    assert synced.status_code == 200, synced.text
    assert asyncio.run(client.app.state.store.get_session(session_id)).title == "Demo"
