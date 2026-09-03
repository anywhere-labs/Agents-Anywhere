# ruff: noqa: F403, F405, I001

from __future__ import annotations

import posixpath
from pathlib import PurePosixPath, PureWindowsPath

from sqlalchemy import case

from agent_server.infra.repositories.store_support import *


def _clean_workspace_path(path: str, device_os: str | None) -> tuple[str, str]:
    cleaned = path.strip()
    if not cleaned:
        raise ValueError("workspacePath must not be empty")

    looks_windows = device_os == "windows" or (
        len(cleaned) >= 3 and cleaned[1] == ":" and cleaned[2] in ("/", "\\")
    ) or cleaned.startswith("\\\\")
    if looks_windows:
        windows_path = PureWindowsPath(cleaned)
        if not windows_path.is_absolute():
            raise ValueError("workspacePath must be an absolute path")
        display = str(windows_path)
        return display, windows_path.as_posix().casefold()

    posix_path = PurePosixPath(cleaned)
    if not posix_path.is_absolute():
        raise ValueError("workspacePath must be an absolute path")
    display = posixpath.normpath(cleaned)
    return display, display


def _project_from_row(row: Any) -> ProjectView:
    return ProjectView(
        id=row["id"],
        userId=row["user_id"],
        connectorId=row["connector_id"],
        name=row["name"],
        workspacePath=row["workspace_path"],
        pinned=bool(row["pinned"]),
        pinnedAt=row["pinned_at"],
        activeSessionCount=int(row.get("active_session_count") or 0),
        lastActivityAt=row.get("last_activity_at"),
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def _project_view_query() -> Any:
    effective_archived = or_(
        sessions_t.c.archived == 1,
        and_(
            sessions_t.c.runtime != "dsh",
            sessions_t.c.source_state.in_(
                ("archived", "unavailable", "deleted", "missing")
            ),
        ),
    )
    active_count = func.sum(
        case(
            (
                and_(sessions_t.c.id.is_not(None), ~effective_archived),
                1,
            ),
            else_=0,
        )
    ).label("active_session_count")
    last_activity = func.max(
        func.coalesce(
            sessions_t.c.sort_at,
            sessions_t.c.last_activity_at,
            sessions_t.c.created_at,
        )
    ).label("last_activity_at")
    return (
        select(projects_t, active_count, last_activity)
        .select_from(
            projects_t.outerjoin(
                sessions_t,
                sessions_t.c.project_id == projects_t.c.id,
            )
        )
        .group_by(*projects_t.c)
    )


class ProjectRepositoryMixin:
    async def list_projects(self, *, user_id: str) -> list[ProjectView]:
        query = (
            _project_view_query()
            .where(projects_t.c.user_id == user_id)
            .order_by(
                projects_t.c.pinned.desc(),
                projects_t.c.pinned_at.desc(),
                func.max(
                    func.coalesce(
                        sessions_t.c.sort_at,
                        sessions_t.c.last_activity_at,
                        sessions_t.c.created_at,
                    )
                ).desc(),
                projects_t.c.updated_at.desc(),
                projects_t.c.id.desc(),
            )
        )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
        return [_project_from_row(row) for row in rows]

    async def get_project(self, project_id: str, *, user_id: str) -> ProjectView:
        query = _project_view_query().where(
            projects_t.c.id == project_id,
            projects_t.c.user_id == user_id,
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(query)).mappings().first()
        if row is None:
            raise KeyError(project_id)
        return _project_from_row(row)

    async def create_project(
        self,
        *,
        user_id: str,
        connector_id: str,
        name: str,
        workspace_path: str,
    ) -> ProjectView:
        cleaned_name = name.strip()
        if not cleaned_name:
            raise ValueError("name must not be empty")
        project_id = f"proj_{secrets.token_urlsafe(10)}"
        now = utc_now()
        try:
            async with self._engine.begin() as conn:
                connector = (
                    await conn.execute(
                        select(connectors_t.c.device_os).where(
                            connectors_t.c.id == connector_id,
                            connectors_t.c.user_id == user_id,
                            connectors_t.c.revoked == 0,
                        )
                    )
                ).first()
                if connector is None:
                    raise KeyError(connector_id)
                cleaned_path, workspace_key = _clean_workspace_path(
                    workspace_path,
                    connector.device_os,
                )
                await conn.execute(
                    insert(projects_t).values(
                        id=project_id,
                        user_id=user_id,
                        connector_id=connector_id,
                        name=cleaned_name,
                        workspace_path=cleaned_path,
                        workspace_key=workspace_key,
                        pinned=0,
                        created_at=now,
                        updated_at=now,
                    )
                )
        except IntegrityError as exc:
            raise ValueError("a project already exists for this workspace") from exc
        return await self.get_project(project_id, user_id=user_id)

    async def update_project(
        self,
        project_id: str,
        *,
        user_id: str,
        name: str | None = None,
        pinned: bool | None = None,
    ) -> ProjectView:
        current = await self.get_project(project_id, user_id=user_id)
        values: dict[str, Any] = {"updated_at": utc_now()}
        if name is not None:
            cleaned_name = name.strip()
            if not cleaned_name:
                raise ValueError("name must not be empty")
            values["name"] = cleaned_name
        if pinned is not None:
            values["pinned"] = int(pinned)
            values["pinned_at"] = (
                current.pinnedAt if pinned and current.pinned else utc_now() if pinned else None
            )
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(projects_t)
                .where(
                    projects_t.c.id == project_id,
                    projects_t.c.user_id == user_id,
                )
                .values(**values)
            )
        if result.rowcount == 0:
            raise KeyError(project_id)
        return await self.get_project(project_id, user_id=user_id)

    async def delete_project(self, project_id: str, *, user_id: str) -> int:
        now = utc_now()
        async with self._engine.begin() as conn:
            owned = (
                await conn.execute(
                    select(projects_t.c.id).where(
                        projects_t.c.id == project_id,
                        projects_t.c.user_id == user_id,
                    )
                )
            ).first()
            if owned is None:
                raise KeyError(project_id)
            detached_result = await conn.execute(
                update(sessions_t)
                .where(sessions_t.c.project_id == project_id)
                .values(project_id=None, updated_at=now)
            )
            await conn.execute(
                delete(projects_t).where(
                    projects_t.c.id == project_id,
                    projects_t.c.user_id == user_id,
                )
            )
        return int(detached_result.rowcount or 0)

    async def list_project_sessions_page(
        self,
        project_id: str,
        *,
        archived: bool,
        limit: int,
        cursor: str | None,
        user_id: str,
    ) -> tuple[list[SessionView], bool, str | None]:
        await self.get_project(project_id, user_id=user_id)
        return await self.list_sessions_page(
            archived=archived,
            limit=limit,
            cursor=cursor,
            user_id=user_id,
            project_id=project_id,
        )

    async def archive_project_sessions(
        self,
        project_id: str,
        archived: bool,
        *,
        scope: str,
        user_id: str,
    ) -> list[SessionView]:
        await self.get_project(project_id, user_id=user_id)
        if scope == "active":
            scope_filter = sessions_t.c.archived == 0
        elif scope == "archived":
            scope_filter = sessions_t.c.archived == 1
        elif scope == "all":
            scope_filter = None
        else:
            raise ValueError(f"invalid scope: {scope}")
        query = select(sessions_t.c.id).where(
            sessions_t.c.project_id == project_id,
        )
        if scope_filter is not None:
            query = query.where(scope_filter)
        async with self._engine.connect() as conn:
            session_ids = [
                str(row.id) for row in (await conn.execute(query)).all()
            ]
        if not session_ids:
            return []
        changed, _ = await self.bulk_set_session_archived(
            session_ids,
            archived,
            user_id=user_id,
        )
        return changed
