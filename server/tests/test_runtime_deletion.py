from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from conftest import ApiV2TestClient as TestClient
from sqlalchemy import insert, select, update
from test_connector_deletion import timeline_input
from test_runtime_instances_lifecycle import (
    FakeRuntimeRpc,
    _auth_headers,
    _discover_types,
    _v2_discovery,
)

from agent_server.app import create_app
from agent_server.core.models import SessionRuntimeState
from agent_server.core.utc import utc_now
from agent_server.infra.connector_rpc import ConnectorRpcError
from agent_server.infra.db import schema as db


@pytest.fixture
def api(tmp_path, monkeypatch):
    app = create_app(tmp_path / "runtime-deletion.sqlite3")
    rpc = FakeRuntimeRpc(_v2_discovery())
    # Keep the production service and its cleanup dependencies wired by create_app.
    for method in ("is_online", "request", "request_bound", "is_connection_id_current"):
        monkeypatch.setattr(app.state.rpc, method, getattr(rpc, method))
    client = TestClient(app)
    try:
        headers = _auth_headers(client)
        response = client.post("/connectors", headers=headers, json={"name": "Device"})
        assert response.status_code == 200, response.text
        device = response.json()["connector"]["id"]
        _discover_types(client, device, headers)
        runtime = create_runtime(client, headers, device, "Work")
        yield client, rpc, headers, device, runtime
    finally:
        client.close()
        asyncio.run(app.state.store.close())


def create_runtime(client, headers, device, name):
    response = client.post(
        f"/connectors/{device}/runtimes",
        headers=headers,
        json={
            "runtimeType": "codex",
            "name": name,
            "config": {"home": f"/runtime/{name}"},
            "active": False,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()["runtimeId"]


async def add_session(app, device, runtime, name):
    store = app.state.store
    session = await store.upsert_connector_session(
        connector_id=device,
        session_id=f"sess_{name}",
        runtime="codex",
        runtime_id=runtime,
        external_session_id=name,
        title=name,
        cwd="/work/shared",
    )
    now = utc_now()
    owner = (await store.get_connector(device)).userId
    await store.upsert_timeline_item(
        session_id=session.id, item=timeline_input(session.id)
    )
    async with store.engine.begin() as conn:
        await conn.execute(
            insert(db.session_active_runs).values(
                session_id=session.id,
                runtime="codex",
                runtime_id=runtime,
                status="running",
                started_at=now,
                updated_at=now,
            )
        )
        await conn.execute(
            insert(db.session_shares).values(
                id=session.id,
                session_id=session.id,
                user_id=owner,
                scope="session",
                snapshot_json="{}",
                created_at=now,
            )
        )
        await conn.execute(
            insert(db.connector_terminal_roots).values(
                connector_id=device,
                terminal_id=session.id,
                session_id=session.id,
                root="/work/shared",
                cwd="/work/shared",
                created_at=now,
                updated_at=now,
            )
        )
    await store.save_user_uploaded_file(
        session_id=session.id, user_id=owner, name="private.txt", data=b"attachment"
    )
    await app.state.timeline_write_buffer.accept(
        session_id=session.id, item=timeline_input(session.id, "pending")
    )
    await app.state.session_runtime_state_cache.put(
        SessionRuntimeState(
            sessionId=session.id,
            runtime="codex",
            updatedSeq=1,
            createdAt=now,
            updatedAt=now,
        )
    )
    await app.state.terminal_broker.register(
        connector_id=device,
        session_id=session.id,
        label="Terminal",
        cwd="/work/shared",
        shell="/bin/sh",
        cols=80,
        rows=24,
        persistent=True,
    )
    return session


async def assert_session_data(app, expected_ids):
    store = app.state.store
    async with store.engine.connect() as conn:
        assert (
            set((await conn.execute(select(db.sessions.c.id))).scalars())
            == expected_ids
        )
        for table in (
            db.timeline_items,
            db.session_active_runs,
            db.session_shares,
            db.connector_terminal_roots,
        ):
            assert (
                set((await conn.execute(select(table.c.session_id))).scalars())
                == expected_ids
            ), table.name
    for session_id in expected_ids:
        assert (store.files.root / session_id).exists()
        assert await app.state.session_runtime_state_cache.get(session_id) is not None
        assert await app.state.terminal_broker.get_for_session(session_id)


def test_runtime_deletion_removes_only_its_sessions_and_related_data(api):
    client, rpc, headers, device, runtime = api
    other_runtime = create_runtime(client, headers, device, "Other")
    created = client.post("/connectors", headers=headers, json={"name": "Other device"})
    assert created.status_code == 200, created.text
    other_device = created.json()["connector"]["id"]
    _discover_types(client, other_device, headers)
    other_device_runtime = create_runtime(client, headers, other_device, "Work")
    runtime_url = f"/connectors/{device}/runtimes/{runtime}"
    activated = client.put(
        f"{runtime_url}/active", headers=headers, json={"active": True}
    )
    assert activated.status_code == 200, activated.text

    async def prepare():
        # Runtime IDs are scoped to a device: the same ID elsewhere must survive.
        async with client.app.state.store.engine.begin() as conn:
            await conn.execute(
                update(db.device_runtimes)
                .where(
                    db.device_runtimes.c.connector_id == other_device,
                    db.device_runtimes.c.runtime_id == other_device_runtime,
                )
                .values(runtime_id=runtime)
            )
        deleted = [
            await add_session(client.app, device, runtime, name)
            for name in ("active", "archived", "hidden")
        ]
        kept = [
            await add_session(client.app, device, other_runtime, "other_instance"),
            await add_session(client.app, other_device, runtime, "other_device"),
        ]
        store = client.app.state.store
        await store.set_session_archived(deleted[1].id, True)
        async with store.engine.begin() as conn:
            await conn.execute(
                update(db.sessions)
                .where(db.sessions.c.id == deleted[2].id)
                .values(project_id=None, source_state="deleted")
            )
        return deleted, kept

    deleted, kept = asyncio.run(prepare())
    rpc.requests.clear()
    response = client.delete(f"{runtime_url}/config", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["configured"] is False
    assert rpc.requests == [
        (device, "runtime.stop", {"runtime": "codex", "runtimeId": runtime})
    ]
    for session in deleted:
        assert (
            client.get(f"/sessions/{session.id}/meta", headers=headers).status_code
            == 404
        )
        assert (
            client.get(f"/sessions/{session.id}/timeline", headers=headers).status_code
            == 404
        )
        assert client.get(f"/public/shares/{session.id}").status_code == 404
    assert client.get(f"{runtime_url}", headers=headers).status_code == 200
    assert (
        client.get(
            f"/connectors/{device}/runtimes/{other_runtime}", headers=headers
        ).json()["configured"]
        is True
    )

    async def check():
        await assert_session_data(client.app, {session.id for session in kept})
        store = client.app.state.store
        async with store.engine.connect() as conn:
            assert set((await conn.execute(select(db.projects.c.id))).scalars()) == {
                session.projectId for session in kept
            }
        for session in deleted:
            assert not (store.files.root / session.id).exists()
            assert (
                await client.app.state.session_runtime_state_cache.get(session.id)
                is None
            )
            assert (
                await client.app.state.terminal_broker.get_for_session(session.id) == []
            )
            assert (
                session.id
                not in await client.app.state.timeline_write_buffer.dirty_session_ids()
            )
        await client.app.state.timeline_write_buffer.flush_all()
        for session in deleted:
            assert await store.timeline.read(session.id) == []

    asyncio.run(check())
    assert client.delete(f"{runtime_url}/config", headers=headers).status_code == 200
    asyncio.run(assert_session_data(client.app, {session.id for session in kept}))


@pytest.mark.parametrize("failure", ["offline", "stop_failed"])
def test_running_runtime_deletion_preserves_sessions_when_it_cannot_stop(
    api, monkeypatch, failure
):
    client, rpc, headers, device, runtime = api
    session = asyncio.run(add_session(client.app, device, runtime, "protected"))
    runtime_url = f"/connectors/{device}/runtimes/{runtime}"
    activated = client.put(
        f"{runtime_url}/active", headers=headers, json={"active": True}
    )
    assert activated.status_code == 200, activated.text
    if failure == "offline":
        rpc.online = False
    else:
        monkeypatch.setattr(
            client.app.state.rpc,
            "request",
            AsyncMock(
                side_effect=ConnectorRpcError("stop_failed", "runtime is still running")
            ),
        )
    response = client.delete(f"{runtime_url}/config", headers=headers)
    assert response.status_code == (503 if failure == "offline" else 502), response.text
    assert client.get(runtime_url, headers=headers).json()["configured"] is True
    asyncio.run(assert_session_data(client.app, {session.id}))
    # A failed stop sets status=error and active=False. Retrying must still stop
    # the possibly running process before it can delete any session data.
    retried = client.delete(f"{runtime_url}/config", headers=headers)
    assert retried.status_code == response.status_code, retried.text
    asyncio.run(assert_session_data(client.app, {session.id}))


def test_stopping_runtime_keeps_sessions(api):
    client, _, headers, device, runtime = api
    session = asyncio.run(add_session(client.app, device, runtime, "stopped"))
    active_url = f"/connectors/{device}/runtimes/{runtime}/active"
    assert (
        client.put(active_url, headers=headers, json={"active": True}).status_code
        == 200
    )
    assert (
        client.put(active_url, headers=headers, json={"active": False}).status_code
        == 200
    )
    asyncio.run(assert_session_data(client.app, {session.id}))


def test_stopped_runtime_can_be_deleted_while_connector_is_offline(api):
    client, rpc, headers, device, runtime = api
    asyncio.run(add_session(client.app, device, runtime, "offline"))
    rpc.online = False
    response = client.delete(
        f"/connectors/{device}/runtimes/{runtime}/config", headers=headers
    )
    assert response.status_code == 200, response.text
    asyncio.run(assert_session_data(client.app, set()))


def test_failed_runtime_attachment_cleanup_rolls_back_and_can_retry(api, monkeypatch):
    client, _, headers, device, runtime = api
    session = asyncio.run(add_session(client.app, device, runtime, "retry"))
    runtime_url = f"/connectors/{device}/runtimes/{runtime}"
    with monkeypatch.context() as patch:
        patch.setattr(
            client.app.state.store.files,
            "delete_session",
            AsyncMock(side_effect=OSError("storage unavailable")),
        )
        with pytest.raises(OSError, match="storage unavailable"):
            client.delete(f"{runtime_url}/config", headers=headers)
    assert client.get(runtime_url, headers=headers).json()["configured"] is True
    asyncio.run(assert_session_data(client.app, {session.id}))
    assert client.delete(f"{runtime_url}/config", headers=headers).status_code == 200
    asyncio.run(assert_session_data(client.app, set()))


def test_unowned_or_missing_runtime_deletion_preserves_sessions(api):
    client, _, headers, device, runtime = api
    session = asyncio.run(add_session(client.app, device, runtime, "owned"))
    client.patch(
        "/admin/settings", headers=headers, json={"registrationOpen": True}
    ).raise_for_status()
    registered = client.post(
        "/auth/register",
        json={
            "email": "other@example.com",
            "displayName": "Other",
            "password": "secret",
        },
    )
    assert registered.status_code == 200, registered.text
    other_headers = {"Authorization": f"Bearer {registered.json()['accessToken']}"}
    url = f"/connectors/{device}/runtimes/{runtime}/config"
    assert client.delete(url).status_code == 401
    assert client.delete(url, headers=other_headers).status_code == 404
    assert (
        client.delete(
            f"/connectors/{device}/runtimes/missing/config", headers=headers
        ).status_code
        == 404
    )
    assert (
        client.get(url.removesuffix("/config"), headers=headers).json()["configured"]
        is True
    )
    asyncio.run(assert_session_data(client.app, {session.id}))
