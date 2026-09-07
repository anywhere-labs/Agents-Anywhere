from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import insert, select

from agent_server.infra.db import connectors, users
from agent_server.infra.db.schema import runtime_workspaces, runtime_workspace_sessions
from agent_server.infra.db.migrations import upgrade_database
from agent_server.infra.repositories.facade import Store
from agent_server.services.connector_notifications import (
    ConnectorNotificationService,
    NotificationValidationError,
)
from agent_server.api.sessions import read_runtime_state_from_connector
from agent_server.core.models import TimelineItemIn
from fastapi import HTTPException

NOW = "2026-09-07T00:00:00Z"


@pytest.fixture
def store(tmp_path):
    path = tmp_path / "native-workspaces.sqlite3"
    upgrade_database(db_url=f"sqlite+aiosqlite:///{path}")
    repository = Store(path)

    async def seed():
        async with repository.engine.begin() as conn:
            await conn.execute(
                insert(users).values(
                    id="owner",
                    password_hash="hash",
                    role="member",
                    disabled=0,
                    created_at=NOW,
                    updated_at=NOW,
                )
            )
            for device in ("device", "other"):
                await conn.execute(
                    insert(connectors).values(
                        id=device,
                        user_id="owner",
                        name=device,
                        status="online",
                        token_hash=f"hash-{device}",
                        token_prefix="prefix",
                        created_at=NOW,
                        updated_at=NOW,
                    )
                )

    asyncio.run(seed())
    yield repository
    asyncio.run(repository.close())


def workspace(id="native-project", title="工作项目", path="/repo", members=()):
    return {"id": id, "title": title, "path": path, "sessionIds": list(members)}


async def inventory(
    store, workspaces, *, complete=True, runtime_id="rti_dsh", connector_id="device"
):
    service = ConnectorNotificationService(
        store, SimpleNamespace(apply=AsyncMock(return_value=False))
    )
    return await service.apply(
        connector_id=connector_id,
        method="workspace.inventory",
        params={
            "runtime": "dsh",
            "runtimeId": runtime_id,
            "workspaces": workspaces,
            "complete": complete,
        },
    )


async def session(store, id="session", cwd="/repo", runtime_id="rti_dsh"):
    return await store.upsert_connector_session(
        connector_id="device",
        session_id=id,
        runtime="dsh",
        runtime_id=runtime_id,
        external_session_id=f"native-{id}",
        cwd=cwd,
    )


def test_calibration_reuses_projects_preserves_pins_and_allocates_stable_chinese_names(
    store,
):
    async def scenario():
        original = await session(store)
        await store.update_project(original.projectId, user_id="owner", pinned=True)
        await store.create_project(
            user_id="owner",
            connector_id="other",
            name="工作项目",
            workspace_path="/foreign",
        )
        snapshot = [
            workspace(members=["session"]),
            workspace("second", path="/second"),
            workspace("third", path="/third"),
        ]
        await inventory(store, snapshot)
        projects = {
            p.workspacePath: p for p in await store.list_projects(user_id="owner")
        }
        assert projects["/repo"].id == original.projectId
        assert projects["/repo"].pinned is True
        assert [projects[path].name for path in ("/repo", "/second", "/third")] == [
            "工作项目（1）",
            "工作项目（2）",
            "工作项目（3）",
        ]
        assert projects["/second"].hasNativeWorkspace is True
        assert projects["/second"].activeSessionCount == 0
        assert (await inventory(store, snapshot)).dashboard_changed is False
        assert {p.id: p.name for p in await store.list_projects(user_id="owner")} == {
            p.id: p.name for p in projects.values()
        }
        await store.update_project(
            original.projectId, user_id="owner", name="AA 本地改名"
        )
        await inventory(store, snapshot)
        assert (
            await store.get_project(original.projectId, user_id="owner")
        ).name == "工作项目（1）"
        snapshot[0]["title"] = "新项目名"
        await inventory(store, snapshot)
        assert (
            await store.get_project(original.projectId, user_id="owner")
        ).name == "新项目名"

    asyncio.run(scenario())


def test_membership_precedes_cwd_then_deletion_reclassifies_without_losing_sessions(
    store,
):
    async def scenario():
        grouped = await session(store, cwd="/old-cwd")
        await store.upsert_timeline_item(
            session_id="session",
            item=TimelineItemIn.model_validate(
                {
                    "id": "history",
                    "sessionId": "session",
                    "type": "message",
                    "status": "done",
                    "role": "assistant",
                    "content": {"text": "保留历史", "format": "markdown"},
                    "source": {"runtime": "dsh"},
                    "orderSeq": 1,
                    "revision": 1,
                    "contentHash": "sha256:history",
                }
            ),
        )
        held = set()

        @asynccontextmanager
        async def fence(session_id):
            held.add(session_id)
            try:
                yield
            finally:
                held.remove(session_id)

        async def seal(session_id, _high):
            assert session_id in held, (
                "project moves must participate in the session revision fence"
            )

        store.bind_session_revision_fence(fence)
        store.bind_session_revision_range_sealer(seal)
        await session(store, "ungrouped", cwd="/repo")
        await inventory(
            store, [workspace(members=["session"]), workspace("empty", path="/empty")]
        )
        mapped = await store.get_session("session")
        assert mapped.projectId != grouped.projectId
        assert mapped.projectId == (await store.get_session("ungrouped")).projectId
        # Subsequent history imports must not undo explicit native membership.
        assert (
            await store.update_session_snapshot(session_id="session", cwd="/old-cwd")
        ).projectId == mapped.projectId
        # A same-path, correctly grouped session reuses that project after deletion.
        await inventory(store, [])
        assert (await store.get_session("session")).projectId == grouped.projectId
        ungrouped = await store.get_session("ungrouped")
        assert ungrouped.projectId == mapped.projectId
        assert (
            await store.get_project(mapped.projectId, user_id="owner")
        ).name == "repo"
        assert [item.id for item in await store.timeline.read("session")] == ["history"]
        assert "/empty" not in {
            p.workspacePath for p in await store.list_projects(user_id="owner")
        }
        async with store.engine.connect() as conn:
            assert not (await conn.execute(select(runtime_workspaces))).all()
            assert not (await conn.execute(select(runtime_workspace_sessions))).all()

    asyncio.run(scenario())


def test_concurrent_devices_allocate_distinct_source_names(store):
    async def scenario():
        await asyncio.gather(
            inventory(store, [workspace()]),
            inventory(store, [workspace()], connector_id="other"),
        )
        assert {p.name for p in await store.list_projects(user_id="owner")} == {
            "工作项目",
            "工作项目（1）",
        }

    asyncio.run(scenario())


@pytest.mark.parametrize("payload", [None, {}, {"state": None}, TimeoutError()])
def test_dsh_detail_never_falls_back_to_old_available_state_on_failed_live_read(
    store, payload
):
    async def scenario():
        current = await session(store)
        manager = SimpleNamespace(
            request=AsyncMock(side_effect=payload)
            if isinstance(payload, Exception)
            else AsyncMock(return_value=payload)
        )
        with pytest.raises(HTTPException) as error:
            await read_runtime_state_from_connector(manager, current)
        assert error.value.status_code in {502, 503}

    asyncio.run(scenario())


def test_invalid_or_incomplete_inventory_rolls_back_and_runtime_scope_is_isolated(
    store,
):
    async def scenario():
        await session(store)
        await session(store, "other-runtime", cwd="/another", runtime_id="rti_another")
        await inventory(store, [workspace(members=["session"])])
        await inventory(
            store,
            [workspace(path="/another", title="另一实例", members=["other-runtime"])],
            runtime_id="rti_another",
        )
        before = {p.id: p.name for p in await store.list_projects(user_id="owner")}
        for bad, complete in [
            ([], False),
            ([workspace(), workspace()], True),
            ([workspace(path="relative")], True),
        ]:
            with pytest.raises(NotificationValidationError):
                await inventory(store, bad, complete=complete)
            assert {
                p.id: p.name for p in await store.list_projects(user_id="owner")
            } == before
        await inventory(store, [])
        project = await store.get_project(
            (await store.get_session("other-runtime")).projectId, user_id="owner"
        )
        assert project.name == "另一实例" and project.hasNativeWorkspace

    asyncio.run(scenario())


def test_explicit_archive_import_survives_unknown_reads_and_respects_aa_archive_choices(
    store,
):
    async def scenario():
        await session(store)

        async def observe(availability):
            return await store.update_session_source_state(
                "session",
                availability=availability,
                reason=None,
                observed_at=None,
                observation_origin="event",
            )

        await observe(
            "hidden"
        )  # Upgrade from the old plugin's generic visibility state.
        assert (await observe("archived")).archived is True
        await store.set_session_archived("session", False)
        await observe("missing")
        assert (await observe("archived")).archived is False
        await observe("available")
        assert (await observe("archived")).archived is True
        assert (await observe("available")).archived is True
        # Offline archives are also imported by a complete inventory.
        await store.set_session_archived("session", False)
        await store.begin_session_inventory("device", "dsh", "rti_dsh", "capture")
        await store.complete_session_inventory(
            "device",
            "dsh",
            "rti_dsh",
            "capture",
            [
                {
                    "session_id": "session",
                    "external_session_id": "native-session",
                    "source_state": "archived",
                },
            ],
            complete=True,
        )
        assert (await store.get_session("session")).archived is True

    asyncio.run(scenario())
