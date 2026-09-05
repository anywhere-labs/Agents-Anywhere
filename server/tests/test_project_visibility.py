from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import create_engine, insert, select, text, update
from sqlalchemy.exc import IntegrityError

from agent_server.infra.db import connectors, projects, sessions, users
from agent_server.infra.db.migrations import upgrade_database
from agent_server.infra.repositories.facade import Store

NOW = "2026-09-06T00:00:00Z"


@pytest.fixture
def store(tmp_path):
    path = tmp_path / "project-visibility.sqlite3"
    upgrade_database(db_url=f"sqlite+aiosqlite:///{path}")
    repository = Store(path)

    async def seed():
        async with repository.engine.begin() as connection:
            await connection.execute(
                insert(users).values(
                    id="owner",
                    password_hash="hash",
                    role="member",
                    disabled=0,
                    created_at=NOW,
                    updated_at=NOW,
                )
            )
            await connection.execute(
                insert(connectors).values(
                    id="device",
                    user_id="owner",
                    name="Device",
                    status="online",
                    token_hash="hash",
                    token_prefix="prefix",
                    revoked=0,
                    created_at=NOW,
                    updated_at=NOW,
                )
            )

    asyncio.run(seed())
    try:
        yield repository
    finally:
        asyncio.run(repository.close())


async def add_session(store, project_id, session_id, **values):
    async with store.engine.begin() as connection:
        await connection.execute(
            insert(sessions)
            .values(
                id=session_id,
                connector_id="device",
                project_id=project_id,
                runtime="codex",
                status="idle",
                takeover=0,
                seq=0,
                updated_seq=0,
                created_at=NOW,
                updated_at=NOW,
            )
            .values(**values)
        )


def test_synced_project_is_not_manual_and_client_creation_claims_it(store):
    async def scenario():
        synced = await store.ensure_project_for_workspace(
            connector_id="device",
            workspace_path="/repo",
        )
        assert synced.manuallyCreated is False
        assert synced.sidebarSessionCounts.model_dump() == {"active": 0, "archived": 0}
        manual = await store.create_project(
            user_id="owner",
            connector_id="device",
            name="My project",
            workspace_path="/repo",
        )
        assert manual.id == synced.id
        assert manual.manuallyCreated is True
        refreshed = await store.ensure_project_for_workspace(
            connector_id="device",
            workspace_path="/repo",
        )
        assert refreshed.manuallyCreated is True
        fresh = await store.create_project(
            user_id="owner",
            connector_id="device",
            name="Fresh",
            workspace_path="/fresh",
        )
        assert fresh.manuallyCreated is True

    asyncio.run(scenario())


@pytest.mark.parametrize("session_count", [0, 2])
def test_archiving_project_clears_manual_flag_even_when_empty(store, session_count):
    async def scenario():
        project = await store.create_project(
            user_id="owner",
            connector_id="device",
            name="Manual",
            workspace_path="/repo",
        )
        for index in range(session_count):
            await add_session(store, project.id, f"session-{index}", archived=index % 2)
        archived = await store.archive_project_sessions(
            project.id,
            True,
            scope="all",
            user_id="owner",
        )
        assert len(archived) == session_count
        assert all(session.archived for session in archived)
        updated = await store.get_project(project.id, user_id="owner")
        assert updated.manuallyCreated is False
        assert updated.sidebarSessionCounts.model_dump() == {
            "active": 0,
            "archived": session_count,
        }
        await store.archive_project_sessions(
            project.id, False, scope="all", user_id="owner"
        )
        assert (
            await store.get_project(project.id, user_id="owner")
        ).manuallyCreated is False
        recreated = await store.create_project(
            user_id="owner",
            connector_id="device",
            name="Manual",
            workspace_path="/repo",
        )
        assert recreated.id == project.id
        assert recreated.manuallyCreated is True

    asyncio.run(scenario())


def test_archive_checks_ownership_before_changing_project_or_sessions(store):
    async def scenario():
        project = await store.create_project(
            user_id="owner",
            connector_id="device",
            name="Manual",
            workspace_path="/repo",
        )
        await add_session(store, project.id, "owned-session")
        with pytest.raises(KeyError):
            await store.archive_project_sessions(
                project.id, True, scope="all", user_id="other"
            )
        assert (
            await store.get_project(project.id, user_id="owner")
        ).manuallyCreated is True
        async with store.engine.connect() as connection:
            assert (
                await connection.execute(select(sessions.c.archived))
            ).scalar_one() == 0

    asyncio.run(scenario())


def test_sidebar_counts_match_session_visibility_across_all_pages(store):
    async def scenario():
        project = await store.ensure_project_for_workspace(
            connector_id="device", workspace_path="/repo"
        )
        for index in range(105):
            await add_session(store, project.id, f"active-{index}")
        await add_session(store, project.id, "pinned-active", pinned=1)
        await add_session(store, project.id, "pinned-archived", pinned=1, archived=1)
        await add_session(store, project.id, "runtime-missing", source_state="missing")
        await add_session(
            store, project.id, "dsh-missing", runtime="dsh", source_state="missing"
        )
        result = await store.get_project(project.id, user_id="owner")
        assert result.sidebarSessionCounts.model_dump() == {
            "active": 107,
            "archived": 1,
        }
        async with store.engine.begin() as connection:
            await connection.execute(update(connectors).values(revoked=1))
        result = await store.get_project(project.id, user_id="owner")
        assert result.sidebarSessionCounts.model_dump() == {"active": 0, "archived": 0}

    asyncio.run(scenario())


def test_failed_archive_rolls_back_sessions_and_manual_flag(store):
    async def scenario():
        project = await store.create_project(
            user_id="owner",
            connector_id="device",
            name="Manual",
            workspace_path="/repo",
        )
        await add_session(store, project.id, "rollback-session")
        async with store.engine.begin() as connection:
            await connection.execute(
                text(
                    "CREATE TRIGGER reject_project_archive BEFORE UPDATE ON projects "
                    "WHEN NEW.manually_created = 0 BEGIN SELECT RAISE(ABORT, 'archive failed'); END"
                )
            )
        with pytest.raises(IntegrityError, match="archive failed"):
            await store.archive_project_sessions(
                project.id, True, scope="all", user_id="owner"
            )
        async with store.engine.connect() as connection:
            assert (
                await connection.execute(select(projects.c.manually_created))
            ).scalar_one() is True
            assert (
                await connection.execute(select(sessions.c.archived))
            ).scalar_one() == 0

    asyncio.run(scenario())


def test_v2_31_backfills_existing_projects_and_defaults_new_rows_to_false(tmp_path):
    path = tmp_path / "legacy-projects.sqlite3"
    url = f"sqlite+aiosqlite:///{path}"
    upgrade_database(db_url=url, revision="v2_30")
    engine = create_engine(f"sqlite:///{path}")
    try:
        with engine.begin() as connection:
            connection.execute(
                insert(users).values(
                    id="owner",
                    password_hash="hash",
                    role="member",
                    disabled=0,
                    created_at=NOW,
                    updated_at=NOW,
                )
            )
            connection.execute(
                insert(connectors).values(
                    id="device",
                    user_id="owner",
                    name="Device",
                    status="online",
                    token_hash="hash",
                    token_prefix="prefix",
                    revoked=0,
                    created_at=NOW,
                    updated_at=NOW,
                )
            )
            connection.execute(
                insert(projects).values(
                    id="legacy",
                    user_id="owner",
                    connector_id="device",
                    name="Legacy",
                    workspace_path="/legacy",
                    workspace_key="/legacy",
                    created_at=NOW,
                    updated_at=NOW,
                )
            )
        upgrade_database(db_url=url)
        with engine.begin() as connection:
            assert (
                connection.execute(select(projects.c.manually_created)).scalar_one()
                is False
            )
            connection.execute(
                insert(projects).values(
                    id="new",
                    user_id="owner",
                    connector_id="device",
                    name="New",
                    workspace_path="/new",
                    workspace_key="/new",
                    created_at=NOW,
                    updated_at=NOW,
                )
            )
            assert connection.execute(
                select(projects.c.manually_created)
            ).scalars().all() == [False, False]
    finally:
        engine.dispose()
