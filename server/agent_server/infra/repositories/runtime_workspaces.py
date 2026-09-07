from __future__ import annotations

from typing import Any
from contextlib import AsyncExitStack

from sqlalchemy import and_, delete, insert, select, update
from sqlalchemy.exc import IntegrityError

from agent_server.core.utc import utc_now
from agent_server.infra.db.schema import (
    connectors,
    projects,
    runtime_workspaces as sources,
    runtime_workspace_sessions as members,
    sessions,
)
from agent_server.infra.repositories.projects import (
    _clean_workspace_path,
    _workspace_name,
)


def _source_name(base: str, names: set[str]) -> str:
    base = base[:255]
    candidate, index = base, 1
    while candidate in names:
        suffix = f"（{index}）"
        candidate = f"{base[: 255 - len(suffix)]}{suffix}"
        index += 1
    return candidate


class WorkspaceSyncRace(Exception):
    """A session changed membership after the revision fences were selected."""


class RuntimeWorkspaceRepositoryMixin:
    async def _ensure_project_for_session(
        self,
        conn: Any,
        *,
        connector_id: str,
        runtime_id: str,
        session_id: str,
        workspace_path: str | None,
        now: str | None = None,
    ) -> tuple[str, str]:
        source = (
            await conn.execute(
                select(projects.c.id, projects.c.workspace_path, connectors.c.device_os)
                .select_from(
                    members.join(
                        sources,
                        and_(
                            sources.c.connector_id == members.c.connector_id,
                            sources.c.runtime_id == members.c.runtime_id,
                            sources.c.external_id == members.c.workspace_id,
                        ),
                    )
                    .join(projects, projects.c.id == sources.c.project_id)
                    .join(connectors, connectors.c.id == members.c.connector_id)
                )
                .where(
                    members.c.connector_id == connector_id,
                    members.c.runtime_id == runtime_id,
                    members.c.session_id == session_id,
                    connectors.c.revoked == 0,
                )
            )
        ).first()
        if source:
            cwd, _ = _clean_workspace_path(
                workspace_path or source.workspace_path, source.device_os
            )
            return str(source.id), cwd
        return await self._ensure_project_for_workspace(
            conn,
            connector_id=connector_id,
            workspace_path=workspace_path,
            now=now,
        )

    async def sync_runtime_workspaces(
        self,
        *,
        connector_id: str,
        runtime_id: str,
        workspaces: list[dict[str, Any]],
    ) -> tuple[bool, list[str]]:
        # A different device owned by the same user may claim a name concurrently.
        # Unique constraints plus a fresh transaction close that race.
        for attempt in range(3):
            try:
                affected = await self._workspace_session_changes(
                    connector_id, runtime_id, workspaces
                )
                # Lock revisions before taking device/project database locks, just
                # like session upserts. Rename-only inventories need no session locks.
                async with AsyncExitStack() as stack:
                    for session_id in sorted(affected):
                        await stack.enter_async_context(
                            self.session_revision_fence(session_id)
                        )
                    async with self._engine.begin() as conn:
                        result = await self._sync_runtime_workspaces(
                            conn, connector_id, runtime_id, workspaces, affected
                        )
                    for session_id in result[1]:
                        await self.publish_session_revision_result(
                            session_id,
                            operation="sync_runtime_workspaces",
                            result=await self.get_session(session_id),
                        )
                    return result
            except (IntegrityError, WorkspaceSyncRace):
                if attempt == 2:
                    raise
        raise RuntimeError("workspace synchronization exhausted retries")

    async def _workspace_session_changes(
        self, connector_id: str, runtime_id: str, workspaces: list[dict[str, Any]]
    ) -> set[str]:
        async with self._engine.connect() as conn:
            device_os = (
                await conn.execute(
                    select(connectors.c.device_os).where(
                        connectors.c.id == connector_id
                    )
                )
            ).scalar()
            rows = (
                await conn.execute(
                    select(sessions.c.id, sessions.c.cwd, projects.c.workspace_key)
                    .select_from(
                        sessions.outerjoin(
                            projects, projects.c.id == sessions.c.project_id
                        ),
                    )
                    .where(
                        sessions.c.connector_id == connector_id,
                        sessions.c.runtime_id == runtime_id,
                        sessions.c.runtime == "dsh",
                    )
                )
            ).all()
        paths = {
            session_id: workspace["path"]
            for workspace in workspaces
            for session_id in workspace["sessionIds"]
        }
        affected = set()
        for row in rows:
            try:
                normalized_cwd, _ = _clean_workspace_path(
                    row.cwd or paths.get(row.id, ""), device_os
                )
                _, key = _clean_workspace_path(
                    paths.get(row.id) or normalized_cwd, device_os
                )
            except ValueError:
                continue
            if key != row.workspace_key or normalized_cwd != row.cwd:
                affected.add(row.id)
        return affected

    async def _sync_runtime_workspaces(
        self,
        conn: Any,
        connector_id: str,
        runtime_id: str,
        workspaces: list[dict[str, Any]],
        fenced: set[str],
    ) -> tuple[bool, list[str]]:
        connector = (
            await conn.execute(
                select(connectors.c.user_id, connectors.c.device_os)
                .where(connectors.c.id == connector_id, connectors.c.revoked == 0)
                .with_for_update()
            )
        ).first()
        if connector is None:
            raise KeyError(connector_id)
        scope = and_(
            sources.c.connector_id == connector_id, sources.c.runtime_id == runtime_id
        )
        member_scope = and_(
            members.c.connector_id == connector_id, members.c.runtime_id == runtime_id
        )
        previous = {
            row["external_id"]: row
            for row in (await conn.execute(select(sources).where(scope))).mappings()
        }
        normalized = [
            (workspace, *_clean_workspace_path(workspace["path"], connector.device_os))
            for workspace in workspaces
        ]
        if len({key for _, _, key in normalized}) != len(normalized):
            raise ValueError("native workspaces must have distinct canonical paths")
        now, changed, changed_sessions = utc_now(), False, []
        next_ids = {workspace["id"] for workspace in workspaces}
        removed = [row for key, row in previous.items() if key not in next_ids]
        # Replace only this runtime's native membership; never touch native logs.
        await conn.execute(delete(members).where(member_scope))
        for source in removed:
            await conn.execute(
                delete(sources).where(
                    scope, sources.c.external_id == source["external_id"]
                )
            )
            changed = True

        for workspace, path, key in sorted(
            normalized, key=lambda entry: entry[0]["id"]
        ):
            prior = previous.get(workspace["id"])
            existing = (
                (
                    await conn.execute(
                        select(projects).where(
                            projects.c.connector_id == connector_id,
                            projects.c.id == prior["project_id"]
                            if prior
                            else projects.c.workspace_key == key,
                        )
                    )
                )
                .mappings()
                .first()
            )
            if existing and existing["workspace_key"] != key:
                raise ValueError(
                    "a native workspace identity cannot change its canonical path"
                )
            project_id = (
                str(existing["id"])
                if existing
                else (
                    await self._ensure_project_for_workspace(
                        conn,
                        connector_id=connector_id,
                        workspace_path=path,
                        now=now,
                    )
                )[0]
            )
            names = {
                str(row[0])
                for row in (
                    await conn.execute(
                        select(projects.c.name).where(
                            projects.c.user_id == connector.user_id,
                            projects.c.id != project_id,
                        )
                    )
                ).all()
            }
            title = workspace["title"].strip() or _workspace_name(
                path, connector.device_os
            )
            assigned = (
                prior["assigned_name"]
                if prior
                and prior["source_name"] == title
                and prior["assigned_name"] not in names
                else _source_name(title, names)
            )
            if existing is None or existing["name"] != assigned:
                await conn.execute(
                    update(projects)
                    .where(projects.c.id == project_id)
                    .values(name=assigned, updated_at=now)
                )
                changed = True
            values = dict(
                project_id=project_id,
                source_name=title,
                assigned_name=assigned,
                created_project=prior["created_project"] if prior else existing is None,
            )
            if prior:
                await conn.execute(
                    update(sources)
                    .where(scope, sources.c.external_id == workspace["id"])
                    .values(**values)
                )
            else:
                await conn.execute(
                    insert(sources).values(
                        connector_id=connector_id,
                        runtime_id=runtime_id,
                        external_id=workspace["id"],
                        **values,
                    )
                )
                changed = True
            if workspace["sessionIds"]:
                await conn.execute(
                    insert(members),
                    [
                        dict(
                            connector_id=connector_id,
                            runtime_id=runtime_id,
                            workspace_id=workspace["id"],
                            session_id=session_id,
                        )
                        for session_id in workspace["sessionIds"]
                    ],
                )

        # Includes sessions detached by a native project deletion and sessions
        # that were already ungrouped while this plugin was offline.
        native_sessions = (
            await conn.execute(
                select(sessions.c.id, sessions.c.project_id, sessions.c.cwd).where(
                    sessions.c.connector_id == connector_id,
                    sessions.c.runtime_id == runtime_id,
                    sessions.c.runtime == "dsh",
                )
            )
        ).all()
        for session in native_sessions:
            try:
                project_id, cwd = await self._ensure_project_for_session(
                    conn,
                    connector_id=connector_id,
                    runtime_id=runtime_id,
                    session_id=session.id,
                    workspace_path=session.cwd,
                    now=now,
                )
            except ValueError:
                # An invalid old cwd is not grounds to move or delete a session.
                continue
            if project_id != session.project_id or cwd != session.cwd:
                if session.id not in fenced:
                    raise WorkspaceSyncRace()
                await self._bump_session(conn, session.id, mark_read=True)
                await conn.execute(
                    update(sessions)
                    .where(sessions.c.id == session.id)
                    .values(project_id=project_id, cwd=cwd)
                )
                changed_sessions.append(session.id)
                changed = True

        for source in removed:
            project = (
                (
                    await conn.execute(
                        select(projects).where(projects.c.id == source["project_id"])
                    )
                )
                .mappings()
                .first()
            )
            if (
                project is None
                or (
                    await conn.execute(
                        select(sources.c.project_id)
                        .where(sources.c.project_id == project["id"])
                        .limit(1)
                    )
                ).first()
            ):
                continue
            attached = (
                await conn.execute(
                    select(sessions.c.id)
                    .where(sessions.c.project_id == project["id"])
                    .limit(1)
                )
            ).first()
            if (
                not attached
                and source["created_project"]
                and not project["manually_created"]
                and not project["pinned"]
            ):
                await conn.execute(
                    delete(projects).where(projects.c.id == project["id"])
                )
            else:
                names = {
                    str(row[0])
                    for row in (
                        await conn.execute(
                            select(projects.c.name).where(
                                projects.c.user_id == connector.user_id,
                                projects.c.id != project["id"],
                            )
                        )
                    ).all()
                }
                await conn.execute(
                    update(projects)
                    .where(projects.c.id == project["id"])
                    .values(
                        name=_source_name(
                            _workspace_name(
                                project["workspace_path"], connector.device_os
                            ),
                            names,
                        ),
                        updated_at=now,
                    )
                )
        return changed, changed_sessions
