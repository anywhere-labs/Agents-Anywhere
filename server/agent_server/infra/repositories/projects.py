# ruff: noqa: F403, F405, I001

from __future__ import annotations

import posixpath
from pathlib import PurePosixPath, PureWindowsPath

from sqlalchemy import case, tuple_

from agent_server.infra.db import device_runtimes, project_operations, runtime_workspace_inventories

from agent_server.infra.repositories.store_support import *


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


def _project_operation_parameters(request: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in request.items() if key not in {"requestId", "newOperation"}}


def _project_from_row(row: Any, state: dict[str, Any] | None = None) -> ProjectView:
    state = state or {}
    roots = json.loads(row.get("roots_json") or "[]")
    unknown = set(state.get("unknownDirectories", []))
    directories = state.get("directories", {})
    root_states = {root: "unknown" if _clean_workspace_path(root, None)[1] in unknown
                   else directories.get(_clean_workspace_path(root, None)[1], "unknown") for root in roots}
    return ProjectView(
        id=row["id"],
        userId=row["user_id"],
        connectorId=row["connector_id"],
        name=row["name"],
        workspacePath=row["workspace_path"],
        runtime=row.get("runtime"), runtimeId=row.get("runtime_id"),
        nativeProjectId=row.get("native_project_id"), identityKind=row.get("identity_kind", "legacy"),
        roots=json.loads(row.get("roots_json") or "[]"), sourceState=row.get("source_state", "pending"),
        sourceAvailability="unknown" if state.get("syncUnavailable") or state.get("version") != 2 else "available",
        rootStates=root_states,
        lastSyncedAt=row.get("workspace_last_checked_at"),
        manuallyCreated=bool(row["manually_created"]),
        pinned=bool(row["pinned"]),
        pinnedAt=row["pinned_at"],
        activeSessionCount=int(row.get("active_session_count") or 0),
        sidebarSessionCounts={
            "active": int(row.get("sidebar_active_session_count") or 0),
            "archived": int(row.get("sidebar_archived_session_count") or 0),
        },
        lastActivityAt=row.get("last_activity_at"),
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def _project_view_query() -> Any:
    aa_archived = sessions_t.c.archived == 1
    # Match project session pagination and the sidebar's separate pinned section.
    visible_session = and_(
        sessions_t.c.id.is_not(None),
        connectors_t.c.revoked == 0,
    )
    sidebar_active_count = func.sum(
        case(
            (and_(visible_session, ~aa_archived, sessions_t.c.pinned == 0), 1),
            else_=0,
        )
    ).label("sidebar_active_session_count")
    sidebar_archived_count = func.sum(
        case((and_(visible_session, aa_archived), 1), else_=0)
    ).label("sidebar_archived_session_count")
    active_count = func.sum(
        case(
            (
                and_(sessions_t.c.id.is_not(None), ~aa_archived),
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
        select(
            projects_t,
            active_count,
            sidebar_active_count,
            sidebar_archived_count,
            last_activity,
            select(runtime_workspace_inventories.c.observed_at).where(
                runtime_workspace_inventories.c.connector_id == projects_t.c.connector_id,
                runtime_workspace_inventories.c.runtime_id == projects_t.c.runtime_id,
            ).correlate(projects_t).scalar_subquery().label("workspace_last_checked_at"),
        )
        .select_from(
            projects_t.join(
                connectors_t,
                connectors_t.c.id == projects_t.c.connector_id,
            ).outerjoin(
                sessions_t,
                sessions_t.c.project_id == projects_t.c.id,
            )
        )
        .group_by(*projects_t.c)
    )


async def _project_views(conn: Any, rows: Any) -> list[ProjectView]:
    sources = {(row["connector_id"], row["runtime_id"]) for row in rows if row.get("runtime_id")}
    facts = {}
    if sources:
        snapshots = (await conn.execute(select(runtime_workspace_inventories).where(
            tuple_(runtime_workspace_inventories.c.connector_id, runtime_workspace_inventories.c.runtime_id).in_(sources),
        ))).mappings().all()
        facts = {(row["connector_id"], row["runtime_id"]): json.loads(row["snapshot_json"]) for row in snapshots}
    return [_project_from_row(row, facts.get((row["connector_id"], row.get("runtime_id")))) for row in rows]


class ProjectRepositoryMixin:
    async def list_projects(self, *, user_id: str) -> list[ProjectView]:
        query = (
            _project_view_query()
             .where(projects_t.c.user_id == user_id,
                connectors_t.c.revoked == 0,
                projects_t.c.source_state.in_(["active", "pending", "unknown"]),
                or_(projects_t.c.identity_kind == "legacy", select(device_runtimes.c.runtime_id).where(
                    device_runtimes.c.connector_id == projects_t.c.connector_id,
                    device_runtimes.c.runtime_id == projects_t.c.runtime_id,
                    device_runtimes.c.config_json.is_not(None),
                ).exists()))
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
            return await _project_views(conn, rows)

    async def get_project(self, project_id: str, *, user_id: str) -> ProjectView:
        query = _project_view_query().where(
            projects_t.c.id == project_id,
            projects_t.c.user_id == user_id,
        )
        async with self._engine.connect() as conn:
            row = (await conn.execute(query)).mappings().first()
            if row is None:
                raise KeyError(project_id)
            return (await _project_views(conn, [row]))[0]

    async def create_project(self, *, user_id: str, connector_id: str, name: str,
                             workspace_path: str, manually_created: bool = True) -> ProjectView:
        """Import a legacy record for administrative migrations, never native creation."""
        project_id = f"proj_{secrets.token_urlsafe(10)}"
        async with self._engine.begin() as conn:
            device = (await conn.execute(select(connectors_t.c.device_os).where(
                connectors_t.c.id == connector_id, connectors_t.c.user_id == user_id,
                connectors_t.c.revoked == 0,
            ))).first()
            if device is None:
                raise KeyError(connector_id)
            path, key = _clean_workspace_path(workspace_path, device.device_os)
            await conn.execute(insert(projects_t).values(id=project_id, user_id=user_id,
                connector_id=connector_id, name=name.strip(), workspace_path=path, workspace_key=key,
                manually_created=manually_created, created_at=utc_now(), updated_at=utc_now()))
        return await self.get_project(project_id, user_id=user_id)

    async def update_project(self, project_id: str, *, user_id: str,
                             name: str | None = None, pinned: bool | None = None) -> ProjectView:
        current = await self.get_project(project_id, user_id=user_id)
        if name is not None:
            raise ValueError("project names are owned by the native runtime")
        values = {"updated_at": utc_now()}
        if pinned is not None:
            values.update(pinned=int(pinned), pinned_at=(current.pinnedAt or utc_now()) if pinned else None)
        async with self._engine.begin() as conn:
            await conn.execute(update(projects_t).where(projects_t.c.id == project_id,
                projects_t.c.user_id == user_id).values(**values))
        return await self.get_project(project_id, user_id=user_id)

    async def list_pending_project_operations(self, *, user_id: str) -> list[dict[str, Any]]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(select(project_operations).where(
                project_operations.c.user_id == user_id,
                project_operations.c.status.in_(["pending", "unknown", "succeeded"]),
                select(device_runtimes.c.runtime_id).where(
                    device_runtimes.c.connector_id == project_operations.c.connector_id,
                    device_runtimes.c.runtime_id == project_operations.c.runtime_id,
                    device_runtimes.c.config_json.is_not(None),
                ).exists(),
            ).order_by(project_operations.c.created_at.desc()))).mappings().all()
            pending = []
            for row in rows:
                if row["status"] == "succeeded" and json.loads(row["result_json"] or "{}").get("clientAcknowledged"):
                    continue
                pending.append(dict(row))
            return pending

    async def recover_project_operation(self, *, user_id: str, request: dict[str, Any]) -> dict[str, Any] | None:
        # Exact request identity wins, even for an explicit new operation retry.
        async with self._engine.connect() as conn:
            row = (await conn.execute(select(project_operations).where(
                project_operations.c.user_id == user_id,
                project_operations.c.request_id == request["requestId"],
            ))).mappings().first()
        if row is not None:
            if {"newOperation": False, **json.loads(row["request_json"])} != {"newOperation": False, **request}:
                raise ValueError("requestId was reused with different parameters")
            return dict(row)
        if request.get("newOperation"):
            return None
        target = _project_operation_parameters(request)
        matches = [row for row in await self.list_pending_project_operations(user_id=user_id)
                   if _project_operation_parameters(json.loads(row["request_json"])) == target]
        if len(matches) > 1:
            raise ValueError("存在多个相同参数的待核对操作，请从操作列表选择继续核对")
        return matches[0] if matches else None

    async def begin_project_operation(self, *, user_id: str, connector_id: str,
                                      runtime: str, runtime_id: str, request_id: str,
                                      request: dict[str, Any], execution: dict[str, Any] | None = None) -> tuple[dict[str, Any], bool]:
        encoded = json.dumps(request, sort_keys=True)
        async with self._engine.begin() as conn:
            # Serialize receipts per user; concurrent retries cannot execute twice.
            owner = (await conn.execute(select(users_t.c.id).where(users_t.c.id == user_id).with_for_update())).first()
            if owner is None:
                raise KeyError(user_id)
            row = (await conn.execute(select(project_operations).where(
                project_operations.c.user_id == user_id, project_operations.c.request_id == request_id,
            ))).mappings().first()
            if row:
                if {"newOperation": False, **json.loads(row["request_json"])} != {"newOperation": False, **request}:
                    raise ValueError("requestId was reused with different parameters")
                return dict(row), False
            if not request.get("newOperation"):
                # The user row lock also serializes cross-device requests whose
                # requestIds differ after reopening the editor.
                candidates = (await conn.execute(select(project_operations).where(
                    project_operations.c.user_id == user_id,
                    project_operations.c.connector_id == connector_id,
                    project_operations.c.runtime_id == runtime_id,
                    project_operations.c.status.in_(["pending", "unknown", "succeeded"]),
                ).order_by(project_operations.c.created_at.desc()))).mappings().all()
                recoverable = []
                for candidate in candidates:
                    if _project_operation_parameters(json.loads(candidate["request_json"])) != _project_operation_parameters(request):
                        continue
                    if candidate["status"] == "succeeded" and json.loads(candidate["result_json"] or "{}").get("clientAcknowledged"):
                        continue
                    recoverable.append(dict(candidate))
                if len(recoverable) > 1:
                    raise ValueError("存在多个相同参数的待核对操作，请从操作列表选择继续核对")
                if recoverable:
                    return recoverable[0], False
            value = {'id': f"pop_{secrets.token_urlsafe(16)}", 'user_id': user_id, 'connector_id': connector_id,
                         'runtime': runtime, 'runtime_id': runtime_id, 'request_id': request_id, 'request_json': encoded,
                         'status': "pending", 'execution_status': 'queued' if execution is not None else 'reconciling', 'result_json': None, 'created_at': utc_now(), 'updated_at': utc_now()}
            if execution is not None:
                pending = (await conn.execute(select(func.count()).select_from(project_operations).where(
                    project_operations.c.connector_id == connector_id,
                    project_operations.c.status.in_(["pending", "unknown"]),
                ))).scalar_one()
                if pending >= 256:
                    raise ValueError("工作设备未完成操作已达到 256 个，请先核对已有操作")
                value["execution_json"] = json.dumps({**execution, "operationId": value["id"]})
            await conn.execute(insert(project_operations).values(**value))
            return value, True

    async def operation_server_identity(self) -> str:
        from sqlalchemy.dialects.postgresql import insert as pg_insert
        from agent_server.infra.db import instance_settings as settings
        async with self._engine.begin() as conn:
            await conn.execute(pg_insert(settings).values(key="mesh-operation-server-id",
                value=secrets.token_hex(32), updated_at=utc_now()).on_conflict_do_nothing(index_elements=[settings.c.key]))
            return str((await conn.execute(select(settings.c.value).where(
                settings.c.key == "mesh-operation-server-id"))).scalar_one())

    async def claim_mesh_operations(self, *, limit: int = 16) -> list[dict[str, Any]]:
        import time
        now = int(time.time())
        async with self._engine.begin() as conn:
            rows = (await conn.execute(select(project_operations).where(
                or_(project_operations.c.status.in_(["pending", "unknown"]),
                    and_(project_operations.c.status.in_(["succeeded", "failed"]),
                         project_operations.c.delivery_accepted == 1, project_operations.c.result_received == 0)),
                project_operations.c.execution_status != "preparing",
                project_operations.c.lease_until < now,
                project_operations.c.next_dispatch_at <= now,
            ).order_by(project_operations.c.next_dispatch_at).limit(limit).with_for_update(skip_locked=True))).mappings().all()
            claimed = []
            for row in rows:
                generation = row["dispatch_generation"] + 1
                await conn.execute(update(project_operations).where(project_operations.c.id == row["id"]).values(
                    dispatch_generation=generation, lease_until=now + 60, next_dispatch_at=now + 5))
                claimed.append({**dict(row), "dispatch_generation": generation})
            return claimed

    async def acknowledge_mesh_result(self, operation_id: str, generation: int) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(update(project_operations).where(project_operations.c.id == operation_id,
                project_operations.c.dispatch_generation == generation,
                project_operations.c.status.in_(["succeeded", "failed"])).values(result_received=1, lease_until=0))

    async def finish_mesh_attempt(self, operation_id: str, generation: int, *,
                                  execution_status: str, result: dict[str, Any] | None = None,
                                  accepted: bool = False, message: str | None = None) -> None:
        import time
        async with self._engine.begin() as conn:
            row = (await conn.execute(select(project_operations).where(
                project_operations.c.id == operation_id, project_operations.c.dispatch_generation == generation,
                project_operations.c.status.in_(["pending", "unknown"]),
            ).with_for_update())).mappings().first()
            if row is None:
                return
            previous = json.loads(row["result_json"] or "{}")
            value = result if result is not None else previous
            if message:
                value = {**value, "message": message}
            if previous.get("clientAcknowledged"):
                value["clientAcknowledged"] = True
            public = execution_status if execution_status in {"succeeded", "failed", "unknown"} else "pending"
            # An unknown attempt cannot erase evidence of device reception.
            await conn.execute(update(project_operations).where(project_operations.c.id == operation_id).values(
                status=public, execution_status=execution_status, result_json=json.dumps(value),
                delivery_accepted=int(accepted or bool(row["delivery_accepted"])), lease_until=0,
                next_dispatch_at=int(time.time()) + (30 if execution_status == "unknown" else 5), updated_at=utc_now()))

    async def finish_project_operation(self, operation_id: str, status: str, result: dict[str, Any]) -> None:
        # Client receipt acknowledgement is Server-owned, never a Runtime result field.
        result = {key: value for key, value in result.items() if key != "clientAcknowledged"}
        async with self._engine.begin() as conn:
            previous = (await conn.execute(select(project_operations).where(
                project_operations.c.id == operation_id,
            ).with_for_update())).mappings().first()
            if previous is None or (status != "succeeded" and previous["status"] not in {"pending", "unknown"}):
                return
            if json.loads(previous["result_json"] or "{}").get("clientAcknowledged"):
                result = {**result, "clientAcknowledged": True}
            await conn.execute(update(project_operations).where(project_operations.c.id == operation_id).values(
                status=status, result_json=json.dumps(result), updated_at=utc_now()))

    async def acknowledge_project_operation(self, operation_id: str, *, user_id: str) -> None:
        async with self._engine.begin() as conn:
            row = (await conn.execute(select(project_operations).where(
                project_operations.c.id == operation_id, project_operations.c.user_id == user_id,
            ).with_for_update())).mappings().first()
            if row is None:
                raise KeyError(operation_id)
            result = json.loads(row["result_json"] or "{}")
            if row["status"] != "succeeded":
                raise ValueError("operation result is not yet confirmed")
            projected = (await conn.execute(select(projects_t.c.id).where(
                projects_t.c.connector_id == row["connector_id"], projects_t.c.runtime_id == row["runtime_id"],
                projects_t.c.native_project_id == result.get("nativeProjectId"),
            ))).first()
            if projected is None:
                raise ValueError("project is still synchronizing")
            await conn.execute(update(project_operations).where(project_operations.c.id == operation_id).values(
                result_json=json.dumps({**result, "clientAcknowledged": True}), updated_at=utc_now()))

    async def get_project_operation(self, operation_id: str, *, user_id: str) -> dict[str, Any]:
        async with self._engine.connect() as conn:
            row = (await conn.execute(select(project_operations).where(
                project_operations.c.id == operation_id, project_operations.c.user_id == user_id,
            ))).mappings().first()
        if row is None:
            raise KeyError(operation_id)
        return dict(row)

    async def find_native_project(self, *, user_id: str, connector_id: str,
                                  runtime_id: str, native_project_id: str) -> ProjectView | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(_project_view_query().where(projects_t.c.user_id == user_id,
                projects_t.c.connector_id == connector_id, projects_t.c.runtime_id == runtime_id,
                projects_t.c.native_project_id == native_project_id))).mappings().first()
            return (await _project_views(conn, [row]))[0] if row else None

    async def delete_project(self, project_id: str, *, user_id: str) -> int:
        async with self._engine.begin() as conn:
            owned = (
                await conn.execute(
                    select(projects_t.c.id, projects_t.c.identity_kind).where(
                        projects_t.c.id == project_id,
                        projects_t.c.user_id == user_id,
                    )
                )
            ).first()
            if owned is None:
                raise KeyError(project_id)
            if owned.identity_kind != "legacy":
                raise ValueError("native projects must be deleted in the native tool")
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
        from agent_server.infra.repositories.sessions import _session_view_query

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
        now = utc_now()
        async with self._engine.begin() as conn:
            owned = (
                await conn.execute(
                    select(projects_t.c.id).where(
                        projects_t.c.id == project_id,
                        projects_t.c.user_id == user_id,
                    ).with_for_update()
                )
            ).first()
            if owned is None:
                raise KeyError(project_id)
            session_ids = [str(row.id) for row in (await conn.execute(query)).all()]
            if session_ids:
                await conn.execute(
                    update(sessions_t)
                    .where(sessions_t.c.id.in_(session_ids))
                    .values(**_manual_archive_values(archived=archived, now=now))
                )
            if archived:
                await conn.execute(
                    update(projects_t)
                    .where(projects_t.c.id == project_id)
                    .values(manually_created=False, updated_at=now)
                )
        if not session_ids:
            return []
        async with self._engine.connect() as conn:
            rows = (
                (
                    await conn.execute(
                        _session_view_query().where(sessions_t.c.id.in_(session_ids))
                    )
                )
                .mappings()
                .all()
            )
        return [await self._session_from_row(row) for row in rows]
