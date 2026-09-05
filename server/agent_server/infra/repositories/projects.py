# ruff: noqa: F403, F405, I001

from __future__ import annotations

import posixpath
from pathlib import PurePosixPath, PureWindowsPath

from sqlalchemy import case

from agent_server.infra.repositories.store_support import *


class MissingWorkspaceError(ValueError):
    """Raised when a connector session cannot be assigned to a workspace."""


class ProjectNameConflictError(ValueError):
    """Raised when another project owned by the user already has this name."""

    def __init__(self, name: str) -> None:
        self.name = name
        super().__init__(f'project name already exists: "{name}"')


def _clean_workspace_path(path: str, device_os: str | None) -> tuple[str, str]:
    cleaned = path.strip()
    if not cleaned:
        raise ValueError("workspacePath must not be empty")

    looks_windows = (
        device_os == "windows"
        or (len(cleaned) >= 3 and cleaned[1] == ":" and cleaned[2] in ("/", "\\"))
        or cleaned.startswith("\\\\")
    )
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


def _workspace_name(path: str, device_os: str | None) -> str:
    """Return the final directory component used for an auto-created project."""
    looks_windows = (
        device_os == "windows"
        or (len(path) >= 3 and path[1] == ":" and path[2] in ("/", "\\"))
        or path.startswith("\\\\")
    )
    name = PureWindowsPath(path).name if looks_windows else PurePosixPath(path).name
    return name or "Workspace"


def _next_project_name(base: str, existing_names: set[str]) -> str:
    candidate = base
    suffix = 1
    while candidate in existing_names:
        candidate = f"{base} ({suffix})"
        suffix += 1
    return candidate


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
    async def _ensure_project_for_workspace(
        self,
        conn: Any,
        *,
        connector_id: str,
        workspace_path: str | None,
        now: str | None = None,
    ) -> tuple[str, str]:
        """Find or create the project that owns a connector workspace.

        The helper is intentionally transaction-friendly so session upserts can
        assign the project and write the session in one transaction.
        """
        connector = (
            (
                await conn.execute(
                    select(
                        connectors_t.c.user_id,
                        connectors_t.c.device_os,
                    ).where(connectors_t.c.id == connector_id)
                )
            )
            .mappings()
            .first()
        )
        if connector is None:
            raise KeyError(connector_id)

        device_os = connector["device_os"]
        if not isinstance(workspace_path, str) or not workspace_path.strip():
            raise MissingWorkspaceError("session workdir is required")
        candidate_path = workspace_path.strip()
        cleaned_path, workspace_key = _clean_workspace_path(candidate_path, device_os)
        existing = (
            await conn.execute(
                select(projects_t.c.id)
                .where(
                    projects_t.c.user_id == connector["user_id"],
                    projects_t.c.connector_id == connector_id,
                    projects_t.c.workspace_key == workspace_key,
                )
                .order_by(projects_t.c.created_at.asc(), projects_t.c.id.asc())
                .limit(1)
            )
        ).first()
        if existing is not None:
            return str(existing.id), cleaned_path

        existing_names = {
            str(row[0])
            for row in (
                await conn.execute(
                    select(projects_t.c.name).where(
                        projects_t.c.user_id == connector["user_id"]
                    )
                )
            ).all()
        }
        name = _next_project_name(
            _workspace_name(cleaned_path, device_os),
            existing_names,
        )
        project_id = f"proj_{secrets.token_urlsafe(10)}"
        timestamp = now or utc_now()
        await conn.execute(
            insert(projects_t).values(
                id=project_id,
                user_id=connector["user_id"],
                connector_id=connector_id,
                name=name,
                workspace_path=cleaned_path,
                workspace_key=workspace_key,
                pinned=0,
                created_at=timestamp,
                updated_at=timestamp,
            )
        )
        return project_id, cleaned_path

    async def ensure_project_for_workspace(
        self,
        *,
        connector_id: str,
        workspace_path: str | None,
        user_id: str | None = None,
    ) -> ProjectView:
        """Public wrapper used by migrations/tools and sync-focused callers."""
        async with self._engine.begin() as conn:
            connector = (
                await conn.execute(
                    select(connectors_t.c.user_id).where(
                        connectors_t.c.id == connector_id
                    )
                )
            ).first()
            if connector is None or (
                user_id is not None and connector.user_id != user_id
            ):
                raise KeyError(connector_id)
            project_id, _ = await self._ensure_project_for_workspace(
                conn,
                connector_id=connector_id,
                workspace_path=workspace_path,
            )
        return await self.get_project(project_id, user_id=connector.user_id)

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
                existing_workspace = (
                    await conn.execute(
                        select(projects_t.c.id).where(
                            projects_t.c.user_id == user_id,
                            projects_t.c.connector_id == connector_id,
                            projects_t.c.workspace_key == workspace_key,
                        )
                    )
                ).first()
                existing_project_id = (
                    str(existing_workspace.id)
                    if existing_workspace is not None
                    else None
                )
                name_conflict = (
                    await conn.execute(
                        select(projects_t.c.id).where(
                            projects_t.c.user_id == user_id,
                            projects_t.c.name == cleaned_name,
                            projects_t.c.id != (existing_project_id or ""),
                        )
                    )
                ).first()
                if name_conflict is not None:
                    raise ProjectNameConflictError(cleaned_name)

                if existing_project_id is not None:
                    project_id = existing_project_id
                    await conn.execute(
                        update(projects_t)
                        .where(projects_t.c.id == project_id)
                        .values(
                            name=cleaned_name,
                            workspace_path=cleaned_path,
                            updated_at=now,
                        )
                    )
                else:
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
            # The preflight checks provide the normal UX path. The database
            # constraint closes the concurrent-create race.
            raise ProjectNameConflictError(cleaned_name) from exc
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
                current.pinnedAt
                if pinned and current.pinned
                else utc_now()
                if pinned
                else None
            )
        try:
            async with self._engine.begin() as conn:
                if name is not None:
                    name_conflict = (
                        await conn.execute(
                            select(projects_t.c.id).where(
                                projects_t.c.user_id == user_id,
                                projects_t.c.name == cleaned_name,
                                projects_t.c.id != project_id,
                            )
                        )
                    ).first()
                    if name_conflict is not None:
                        raise ProjectNameConflictError(cleaned_name)
                result = await conn.execute(
                    update(projects_t)
                    .where(
                        projects_t.c.id == project_id,
                        projects_t.c.user_id == user_id,
                    )
                    .values(**values)
                )
        except IntegrityError as exc:
            if name is not None:
                raise ProjectNameConflictError(cleaned_name) from exc
            raise
        if result.rowcount == 0:
            raise KeyError(project_id)
        return await self.get_project(project_id, user_id=user_id)

    async def delete_project(self, project_id: str, *, user_id: str) -> int:
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
            attached = int(
                (
                    await conn.execute(
                        select(func.count())
                        .select_from(sessions_t)
                        .where(sessions_t.c.project_id == project_id)
                    )
                ).scalar_one()
                or 0
            )
            if attached:
                raise ValueError(
                    "project has sessions; archive or move them before deleting it"
                )
            await conn.execute(
                delete(projects_t).where(
                    projects_t.c.id == project_id,
                    projects_t.c.user_id == user_id,
                )
            )
        return 0

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
            session_ids = [str(row.id) for row in (await conn.execute(query)).all()]
        if not session_ids:
            return []
        changed, _ = await self.bulk_set_session_archived(
            session_ids,
            archived,
            user_id=user_id,
        )
        return changed
