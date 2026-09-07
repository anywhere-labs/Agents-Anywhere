from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest
from conftest import ApiV2TestClient as TestClient
from fakeredis import FakeAsyncRedis
from sqlalchemy import insert, select, text, update
from sqlalchemy.exc import IntegrityError

from agent_server.app import create_app
from agent_server.core.models import SessionRuntimeState, TimelineItemIn
from agent_server.core.utc import utc_now
from agent_server.infra.db import connectors, projects, sessions
from agent_server.infra.db import schema as db
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.timeline_write_buffer import TimelineWriteBuffer


DEVICE_CHILD_TABLES = (
    db.connector_runtime_types,
    db.device_runtimes,
    db.connector_runtime_catalogs,
    db.connector_protocol_capabilities,
    db.connector_terminal_roots,
    db.fs_preview_tokens,
    db.pairing_codes,
)
SESSION_CHILD_TABLES = (db.timeline_items, db.session_active_runs, db.session_shares)


@pytest.fixture
def api(tmp_path):
    with TestClient(create_app(tmp_path / "connector-deletion.sqlite3")) as client:
        client.get("/auth/config")
        registered = client.post(
            "/auth/register",
            json={
                "email": "owner@example.com",
                "displayName": "Owner",
                "password": "secret",
                "setupToken": client.app.state.setup_token.peek(),
            },
        )
        assert registered.status_code == 200, registered.text
        headers = {"Authorization": f"Bearer {registered.json()['accessToken']}"}
        yield client, headers


def create_device(client, headers, name="Device"):
    response = client.post("/connectors", headers=headers, json={"name": name})
    assert response.status_code == 200, response.text
    return response.json()["connector"]["id"]


def create_project(client, headers, device, name, *, manual=True):
    response = client.post(
        "/projects",
        headers=headers,
        json={
            "connectorId": device,
            "name": name,
            "workspacePath": f"/work/{name}",
            "manuallyCreated": manual,
        },
    )
    assert response.status_code == 200, response.text
    return response.json()["project"]["id"]


def add_session(client, device, project, name, *, archived=False):
    async def create():
        store = client.app.state.store
        session = await store.create_session(
            connector_id=device,
            project_id=project,
            runtime="codex",
            external_session_id=name,
            title=name,
            cwd=None,
        )
        if archived:
            await store.set_session_archived(session.id, True)
        return session.id

    return asyncio.run(create())


def timeline_input(session, item_id="item"):
    return TimelineItemIn.model_validate(
        {
            "id": item_id,
            "sessionId": session,
            "type": "message",
            "status": "done",
            "role": "assistant",
            "content": {"text": "Device history", "format": "markdown"},
            "source": {
                "runtime": "codex",
                "sessionId": "thread",
                "itemId": item_id,
                "itemType": "agentMessage",
            },
            "orderSeq": 1,
            "revision": 1,
            "contentHash": "sha256:history",
        }
    )


async def add_related_data(store, device, session):
    now = utc_now()
    owner = (await store.get_connector(device)).userId
    await store.upsert_timeline_item(session_id=session, item=timeline_input(session))
    rows = (
        (
            db.connector_runtime_types,
            dict(
                connector_id=device,
                runtime_type="codex",
                implementation_type="codex",
                display_name="Codex",
                discovery_json="{}",
                defaults_json="{}",
                capabilities_json="{}",
                metadata_json="{}",
                instance_policy="single",
                last_discovered_at=now,
                created_at=now,
                updated_at=now,
            ),
        ),
        (
            db.device_runtimes,
            dict(
                connector_id=device,
                runtime_id="codex",
                runtime_type="codex",
                name="Codex",
                name_key="codex",
                config_json='{"private":"config"}',
                created_at=now,
                updated_at=now,
            ),
        ),
        (
            db.connector_runtime_catalogs,
            dict(
                connector_id=device,
                runtime="codex",
                catalog_type="model",
                revision=1,
                catalog_json="{}",
                updated_at=now,
            ),
        ),
        (
            db.connector_protocol_capabilities,
            dict(
                connector_id=device,
                revision=1,
                capabilities_json="{}",
                updated_at=now,
            ),
        ),
        (
            db.connector_terminal_roots,
            dict(
                connector_id=device,
                terminal_id="terminal",
                session_id=session,
                root="/work",
                cwd="/work",
                created_at=now,
                updated_at=now,
            ),
        ),
        (
            db.fs_preview_tokens,
            dict(
                token_hash=device,
                user_id=owner,
                connector_id=device,
                root="/work",
                path="notes.md",
                expires_at=now,
                created_at=now,
            ),
        ),
        (
            db.pairing_codes,
            dict(
                id=device,
                code=device,
                status="claimed",
                connector_id=device,
                connector_token="pairing-credential",
                expires_at=now,
                created_at=now,
            ),
        ),
        (
            db.session_active_runs,
            dict(
                session_id=session,
                runtime="codex",
                status="running",
                params_json='{"input":"private input"}',
                started_at=now,
                updated_at=now,
            ),
        ),
        (
            db.session_shares,
            dict(
                id=session,
                session_id=session,
                user_id=owner,
                scope="session",
                snapshot_json="{}",
                created_at=now,
            ),
        ),
    )
    async with store.engine.begin() as conn:
        for table, values in rows:
            await conn.execute(insert(table).values(**values))
    return await store.save_user_uploaded_file(
        session_id=session,
        user_id=owner,
        name="private.txt",
        data=b"private attachment",
    )


async def add_terminals(broker, device, session):
    terminal_ids = []
    for mode, persistent in (("create", False), ("create", True), ("attach", True)):
        terminal = await broker.register(
            connector_id=device,
            session_id=session,
            label="Terminal",
            cwd="/work",
            shell="/bin/sh",
            cols=80,
            rows=24,
            relay_mode=mode,
            persistent=persistent,
        )
        await broker.on_output(terminal.id, data=b"private terminal output", seq=1)
        terminal_ids.append(terminal.id)
    return terminal_ids


def test_device_deletion_physically_removes_all_related_data(api):
    client, headers = api
    device = create_device(client, headers)
    other = create_device(client, headers, "Other device")
    empty = create_project(client, headers, device, "Empty")
    active = create_project(client, headers, device, "Active")
    archived = create_project(client, headers, device, "Archived", manual=False)
    other_project = create_project(client, headers, other, "Other")
    active_session = add_session(client, device, active, "active")
    archived_session = add_session(client, device, archived, "archived", archived=True)
    other_session = add_session(client, other, other_project, "other")
    detached_session = add_session(client, device, active, "legacy-detached")
    store = client.app.state.store
    deleted_file = asyncio.run(add_related_data(store, device, active_session))
    other_file = asyncio.run(add_related_data(store, other, other_session))
    terminals = client.app.state.terminal_broker
    deleted_terminals = asyncio.run(add_terminals(terminals, device, active_session))
    other_terminals = asyncio.run(add_terminals(terminals, other, other_session))

    async def prepare():
        # Historical sessions can have no project, or be hidden at their source.
        async with store.engine.begin() as conn:
            await conn.execute(
                update(sessions)
                .where(sessions.c.id == detached_session)
                .values(
                    project_id=None,
                    source_state="deleted",
                )
            )
        await client.app.state.timeline_write_buffer.accept(
            session_id=active_session,
            item=timeline_input(active_session, "pending"),
        )
        await client.app.state.session_runtime_state_cache.put(
            SessionRuntimeState(
                sessionId=active_session,
                runtime="codex",
                updatedSeq=1,
                createdAt=utc_now(),
                updatedAt=utc_now(),
                metadata={"private": "state"},
            )
        )

    asyncio.run(prepare())
    assert (
        client.patch(
            f"/projects/{active}", headers=headers, json={"pinned": True}
        ).status_code
        == 200
    )

    response = client.delete(f"/connectors/{device}", headers=headers)
    assert response.status_code == 204, response.text
    remaining = client.get("/projects", headers=headers).json()["projects"]
    assert [project["id"] for project in remaining] == [other_project]
    for project in (empty, active, archived):
        assert (
            client.get(f"/projects/{project}/sessions", headers=headers).status_code
            == 404
        )
    assert client.get(f"/connectors/{device}", headers=headers).status_code == 404
    assert client.get(f"/connectors/{other}", headers=headers).status_code == 200
    for session in (active_session, archived_session, detached_session):
        assert (
            client.get(f"/sessions/{session}/meta", headers=headers).status_code == 404
        )
        assert (
            client.get(f"/sessions/{session}/timeline", headers=headers).status_code
            == 404
        )
    assert client.get(f"/public/shares/{active_session}").status_code == 404

    async def check_rows():
        async with client.app.state.store.engine.connect() as connection:
            assert list(
                (await connection.execute(select(connectors.c.id))).scalars()
            ) == [other]
            assert list(
                (await connection.execute(select(projects.c.id))).scalars()
            ) == [other_project]
            attached = dict(
                (
                    await connection.execute(
                        select(sessions.c.id, sessions.c.project_id)
                    )
                ).all()
            )
            assert attached == {
                other_session: other_project,
            }
            for table in DEVICE_CHILD_TABLES:
                assert list(
                    (await connection.execute(select(table.c.connector_id))).scalars()
                ) == [other], table.name
            for table in SESSION_CHILD_TABLES:
                assert list(
                    (await connection.execute(select(table.c.session_id))).scalars()
                ) == [other_session], table.name
        assert not await store.files.exists(active_session, deleted_file["fileId"])
        assert not (store.files.root / active_session).exists()
        assert await store.files.exists(other_session, other_file["fileId"])
        for terminal_id in deleted_terminals:
            assert await terminals.get(terminal_id) is None
        for terminal_id in other_terminals:
            assert await terminals.get(terminal_id) is not None
        assert (
            await client.app.state.session_runtime_state_cache.get(active_session)
            is None
        )
        assert (
            active_session
            not in await client.app.state.timeline_write_buffer.dirty_session_ids()
        )
        # Flushing after deletion must not recreate any timeline data.
        await client.app.state.timeline_write_buffer.flush_all()
        assert await store.timeline.read(active_session) == []
        with pytest.raises(KeyError):
            await store.save_user_uploaded_file(
                session_id=active_session,
                user_id=(await store.get_connector(other)).userId,
                name="late.txt",
                data=b"late upload",
            )
        assert not (store.files.root / active_session).exists()

    asyncio.run(check_rows())
    # Deleting the records also frees project names for another device.
    assert create_project(client, headers, other, "Active") != active


def test_unowned_or_missing_device_deletion_leaves_projects_untouched(api):
    client, headers = api
    device = create_device(client, headers)
    project = create_project(client, headers, device, "Protected")
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
    registered.raise_for_status()
    other_headers = {"Authorization": f"Bearer {registered.json()['accessToken']}"}
    other_device = create_device(client, other_headers)
    other_project = create_project(client, other_headers, other_device, "Other project")

    assert client.delete(f"/connectors/{device}").status_code == 401
    assert (
        client.delete(f"/connectors/{device}", headers=other_headers).status_code == 404
    )
    assert client.delete("/connectors/missing", headers=headers).status_code == 404
    assert (
        client.get("/projects", headers=headers).json()["projects"][0]["id"] == project
    )
    assert (
        client.get("/projects", headers=other_headers).json()["projects"][0]["id"]
        == other_project
    )
    assert client.delete(f"/connectors/{device}", headers=headers).status_code == 204
    assert (
        client.get("/projects", headers=other_headers).json()["projects"][0]["id"]
        == other_project
    )


def test_token_rotation_keeps_device_projects(api):
    client, headers = api
    device = create_device(client, headers)
    project = create_project(client, headers, device, "Retained")
    add_session(client, device, project, "retained")
    response = client.post(f"/connectors/{device}/revoke", headers=headers)
    assert response.status_code == 200, response.text
    assert (
        client.get("/projects", headers=headers).json()["projects"][0]["id"] == project
    )
    assert (
        client.get(f"/projects/{project}/sessions", headers=headers).json()["sessions"][
            0
        ]["projectId"]
        == project
    )


def test_failed_project_cleanup_rolls_back_all_database_deletions(api):
    client, headers = api
    device = create_device(client, headers)
    project = create_project(client, headers, device, "Rollback")
    session = add_session(client, device, project, "rollback")
    saved = asyncio.run(add_related_data(client.app.state.store, device, session))

    async def reject_cleanup():
        async with client.app.state.store.engine.begin() as connection:
            await connection.execute(
                text(
                    "CREATE TRIGGER reject_project_delete BEFORE DELETE ON projects "
                    "BEGIN SELECT RAISE(ABORT, 'cleanup failed'); END"
                )
            )

    asyncio.run(reject_cleanup())
    with pytest.raises(IntegrityError, match="cleanup failed"):
        client.delete(f"/connectors/{device}", headers=headers)

    async def check_rows():
        async with client.app.state.store.engine.connect() as connection:
            assert (
                await connection.execute(
                    select(connectors.c.revoked).where(connectors.c.id == device)
                )
            ).scalar_one() == 0
            assert (
                await connection.execute(
                    select(sessions.c.project_id).where(sessions.c.id == session)
                )
            ).scalar_one() == project
            assert (
                await connection.execute(select(projects.c.id))
            ).scalar_one() == project
            for table in DEVICE_CHILD_TABLES:
                assert (
                    await connection.execute(select(table.c.connector_id))
                ).scalar_one() == device
            for table in SESSION_CHILD_TABLES:
                assert (
                    await connection.execute(select(table.c.session_id))
                ).scalar_one() == session
        assert await client.app.state.store.files.exists(session, saved["fileId"])

    asyncio.run(check_rows())


def test_failed_attachment_cleanup_keeps_device_available_for_retry(api, monkeypatch):
    client, headers = api
    device = create_device(client, headers)
    project = create_project(client, headers, device, "Retry")
    session = add_session(client, device, project, "retry")
    store = client.app.state.store
    saved = asyncio.run(add_related_data(store, device, session))
    with monkeypatch.context() as patch:
        patch.setattr(
            store.files,
            "delete_session",
            AsyncMock(side_effect=OSError("storage unavailable")),
        )
        with pytest.raises(OSError, match="storage unavailable"):
            client.delete(f"/connectors/{device}", headers=headers)
    assert client.get(f"/connectors/{device}", headers=headers).status_code == 200
    assert client.get(f"/sessions/{session}/meta", headers=headers).status_code == 200
    assert asyncio.run(store.files.exists(session, saved["fileId"]))
    assert client.delete(f"/connectors/{device}", headers=headers).status_code == 204
    assert not asyncio.run(store.files.exists(session, saved["fileId"]))


def test_owner_can_physically_purge_a_legacy_revoked_device(api):
    client, headers = api
    device = create_device(client, headers)
    project = create_project(client, headers, device, "Legacy")
    session = add_session(client, device, project, "legacy")

    async def mark_revoked():
        async with client.app.state.store.engine.begin() as conn:
            await conn.execute(
                update(connectors).where(connectors.c.id == device).values(revoked=1)
            )

    asyncio.run(mark_revoked())
    assert client.delete(f"/connectors/{device}", headers=headers).status_code == 204

    async def check_rows():
        async with client.app.state.store.engine.connect() as conn:
            for table in (connectors, projects, sessions):
                assert list((await conn.execute(select(table))).all()) == []
        assert await client.app.state.store.timeline.read(session) == []

    asyncio.run(check_rows())


@pytest.mark.parametrize("distributed", [False, True])
def test_deleted_session_clears_pending_timeline_and_revision_state(api, distributed):
    client, headers = api
    device = create_device(client, headers)
    project = create_project(client, headers, device, "Deleted buffer")
    session = add_session(client, device, project, "deleted buffer")
    other_device = create_device(client, headers, "Other buffer")
    other_project = create_project(client, headers, other_device, "Other buffer")
    other_session = add_session(client, other_device, other_project, "other buffer")

    async def scenario():
        redis = FakeAsyncRedis(decode_responses=True) if distributed else None
        coordinator = RedisCoordinator(client=redis, prefix="delete-test")
        store = client.app.state.store
        buffer = TimelineWriteBuffer(store, TimelineBroker(coordinator), coordinator)
        terminals = TerminalBroker(coordinator)
        try:
            deleted_terminals = await add_terminals(terminals, device, session)
            other_terminals = await add_terminals(
                terminals, other_device, other_session
            )
            for session_id in (session, other_session):
                await buffer.accept(
                    session_id=session_id,
                    item=timeline_input(session_id),
                    source_observed_at=utc_now(),
                    mark_read_on_change=True,
                )
            assert set(await buffer.dirty_session_ids()) == {session, other_session}
            session_ids = await store.delete_connector(device)
            assert session_ids == [session]
            await terminals.remove_for_connector(device)
            for terminal_id in deleted_terminals:
                assert await terminals.get(terminal_id) is None
            for terminal_id in other_terminals:
                assert await terminals.get(terminal_id) is not None
            await buffer.discard_session(session)
            assert await buffer.dirty_session_ids() == [other_session]
            assert await buffer._sequences.published_head(session) is None
            if redis is not None:
                assert (
                    await redis.keys(f"delete-test:timeline-buffer:{session}:*") == []
                )
                assert (
                    await redis.keys(f"delete-test:session-revision:{session}:*") == []
                )
            # Even a replay of the cached item must now fail and cannot resurrect it.
            with pytest.raises(KeyError):
                await buffer.accept(session_id=session, item=timeline_input(session))
            await buffer.flush_all()
            assert await store.timeline.read(session) == []
            assert len(await store.timeline.read(other_session)) == 1
        finally:
            await buffer.close()
            if redis is not None:
                await redis.aclose()

    asyncio.run(scenario())


@pytest.mark.parametrize("existing_session", [False, True])
def test_late_connector_sync_cannot_recreate_projects_after_device_deletion(
    api, existing_session
):
    client, headers = api
    device = create_device(client, headers)
    project = create_project(client, headers, device, "Deleted")
    session = (
        add_session(client, device, project, "existing")
        if existing_session
        else "late-session"
    )
    assert client.delete(f"/connectors/{device}", headers=headers).status_code == 204

    async def sync():
        store = client.app.state.store
        with pytest.raises(KeyError):
            await store.upsert_connector_session(
                connector_id=device,
                session_id=session,
                runtime="codex",
                external_session_id="existing" if existing_session else "late-session",
                cwd="/work/Deleted",
            )
        async with store.engine.connect() as connection:
            assert (
                list((await connection.execute(select(projects.c.id))).scalars()) == []
            )

    asyncio.run(sync())
