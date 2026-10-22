"""Native workspace membership, scoped to one Connector runtime."""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import insert, select, update

from agent_server.core.models import SessionView
from agent_server.core.utc import utc_now
from agent_server.core.workspace_inventory import (
    RuntimeWorkspaceInventory,
    WorkspaceSyncResult,
)
from agent_server.infra.db import (
    connectors,
    projects,
    runtime_workspace_inventories,
    sessions,
)
from agent_server.infra.repositories.projects import (
    MissingWorkspaceError,
    _clean_workspace_path,
    _next_project_name,
)
from agent_server.infra.repositories.store_support import session_revision_fenced


class _WorkspaceSnapshotSuperseded(RuntimeError):
    pass


class WorkspaceRepositoryMixin:
    async def _claim_native_project(
        self, conn: Any, connector_id: str, project_id: str
    ) -> None:
        """An explicit AA rename/creation takes ownership of the project label."""
        rows = (
            (
                await conn.execute(
                    select(runtime_workspace_inventories)
                    .where(
                        runtime_workspace_inventories.c.connector_id == connector_id,
                    )
                    .order_by(runtime_workspace_inventories.c.runtime_id)
                    .with_for_update()
                )
            )
            .mappings()
            .all()
        )
        for row in rows:
            state = json.loads(row["snapshot_json"])
            managed = state.get("managedProjectIds", [])
            if project_id not in managed:
                continue
            state["managedProjectIds"] = [
                value for value in managed if value != project_id
            ]
            await conn.execute(
                update(runtime_workspace_inventories)
                .where(
                    runtime_workspace_inventories.c.connector_id == connector_id,
                    runtime_workspace_inventories.c.runtime_id == row["runtime_id"],
                )
                .values(snapshot_json=json.dumps(state))
            )

    async def _resolve_runtime_session_project(
        self,
        conn: Any,
        *,
        connector_id: str,
        runtime: str,
        runtime_id: str,
        external_session_id: str | None,
        workspace_path: str | None,
        now: str | None = None,
    ) -> tuple[str | None, str]:
        connector = (
            await conn.execute(
                select(connectors.c.device_os)
                .where(
                    connectors.c.id == connector_id,
                    connectors.c.revoked == 0,
                )
                .with_for_update(read=True)
            )
        ).first()
        if connector is None:
            raise KeyError(connector_id)
        raw = (
            await conn.execute(
                select(runtime_workspace_inventories.c.snapshot_json).where(
                    runtime_workspace_inventories.c.connector_id == connector_id,
                    runtime_workspace_inventories.c.runtime_id == runtime_id,
                )
            )
        ).scalar_one_or_none()
        if raw is None:
            # Old plugins and runtimes without workspace inventories keep cwd grouping.
            return await self._ensure_project_for_workspace(
                conn,
                connector_id=connector_id,
                workspace_path=workspace_path,
                now=now,
            )
        if not isinstance(workspace_path, str) or not workspace_path.strip():
            raise MissingWorkspaceError("session workdir is required")
        normalized_cwd, _ = _clean_workspace_path(workspace_path, connector.device_os)
        state = json.loads(raw)
        workspace_id = state["members"].get(external_session_id)
        workspace = state["workspaces"].get(workspace_id)
        if workspace is None:
            if state.get(
                "membershipScope"
            ) == "tracked" and external_session_id not in state.get(
                "trackedSessionIds", []
            ):
                return await self._ensure_project_for_workspace(
                    conn,
                    connector_id=connector_id,
                    workspace_path=workspace_path,
                    now=now,
                )
            return None, normalized_cwd
        project_id, _ = await self._ensure_project_for_workspace(
            conn,
            connector_id=connector_id,
            workspace_path=workspace["path"],
            now=now,
        )
        return project_id, normalized_cwd

    async def sync_runtime_workspaces(
        self,
        *,
        connector_id: str,
        runtime_id: str,
        inventory: RuntimeWorkspaceInventory,
        runtime: str,
    ) -> WorkspaceSyncResult:
        # Receiving a snapshot and applying all of its session changes are two
        # separate stages. Persist the planned IDs so a failed application can
        # resume, including notification of changes committed before the failure.
        fingerprint = hashlib.sha256(
            json.dumps(
                {
                    "membershipScope": inventory.membershipScope,
                    "workspaces": [
                        {
                            **workspace.model_dump(),
                            "sessionIds": sorted(workspace.sessionIds),
                        }
                        for workspace in sorted(
                            inventory.workspaces, key=lambda value: value.id
                        )
                    ],
                },
                sort_keys=True,
            ).encode()
        ).hexdigest()
        observed_at = inventory.observedAt.astimezone(UTC).isoformat()
        async with self._engine.begin() as conn:
            connector = (
                await conn.execute(
                    select(connectors.c.user_id, connectors.c.device_os)
                    .where(
                        connectors.c.id == connector_id,
                        connectors.c.revoked == 0,
                    )
                    .with_for_update()
                )
            ).first()
            if connector is None:
                raise KeyError(connector_id)
            key = (
                runtime_workspace_inventories.c.connector_id == connector_id,
                runtime_workspace_inventories.c.runtime_id == runtime_id,
            )
            prior = (
                (await conn.execute(select(runtime_workspace_inventories).where(*key)))
                .mappings()
                .first()
            )
            previous = json.loads(prior["snapshot_json"]) if prior else {}
            if (
                prior
                and datetime.fromisoformat(prior["observed_at"]) > inventory.observedAt
            ):
                return WorkspaceSyncResult()
            if (
                previous.get("fingerprint") == fingerprint
                and previous.get("applicationComplete") is True
            ):
                if (
                    prior["snapshot_id"] != inventory.snapshotId
                    or prior["observed_at"] != observed_at
                ):
                    await conn.execute(
                        update(runtime_workspace_inventories)
                        .where(*key)
                        .values(
                            snapshot_id=inventory.snapshotId,
                            observed_at=observed_at,
                        )
                    )
                return WorkspaceSyncResult()
            if (
                prior
                and prior["snapshot_id"] == inventory.snapshotId
                and previous.get("fingerprint") not in {None, fingerprint}
            ):
                raise ValueError(
                    "snapshotId was reused for a different workspace inventory"
                )

            # Read project identity and name sets once, rather than once for
            # every workspace. The device lock serializes project writers.
            project_rows = (
                (
                    await conn.execute(
                        select(projects).where(
                            projects.c.connector_id == connector_id,
                        )
                    )
                )
                .mappings()
                .all()
            )
            by_key = {row["workspace_key"]: dict(row) for row in project_rows}
            by_id = {row["id"]: dict(row) for row in project_rows}
            names = set(
                (
                    await conn.execute(
                        select(projects.c.name).where(
                            projects.c.user_id == connector.user_id,
                        )
                    )
                ).scalars()
            )
            paths: set[str] = set()
            normalized = []
            for workspace in inventory.workspaces:
                path, workspace_key = _clean_workspace_path(
                    workspace.path, connector.device_os
                )
                roots = [
                    _clean_workspace_path(root, connector.device_os)[0]
                    for root in workspace.roots or [workspace.path]
                ]
                if workspace_key in paths:
                    raise ValueError(
                        "workspace inventory has duplicate normalized paths"
                    )
                paths.add(workspace_key)
                normalized.append((workspace, path, workspace_key, roots))
            managed = set(previous.get("managedProjectIds", [])) & by_id.keys()
            next_workspaces: dict[str, Any] = {}
            members: dict[str, str] = {}
            active: set[str] = set()
            dashboard_changed = bool(previous.get("pendingDashboardChanged"))
            for workspace, path, workspace_key, roots in normalized:
                row = by_key.get(workspace_key)
                if row is None:
                    name = _next_project_name(workspace.title, names)
                    timestamp = utc_now()
                    row = {
                        "id": f"proj_{secrets.token_urlsafe(10)}",
                        "user_id": connector.user_id,
                        "connector_id": connector_id,
                        "name": name,
                        "workspace_path": path,
                        "workspace_key": workspace_key,
                        "manually_created": True,
                        "pinned": 0,
                        "created_at": timestamp,
                        "updated_at": timestamp,
                    }
                    await conn.execute(insert(projects).values(**row))
                    by_key[workspace_key] = row
                    managed.add(row["id"])
                    names.add(name)
                    dashboard_changed = True
                elif row["id"] in managed:
                    names.discard(row["name"])
                    name = _next_project_name(workspace.title, names)
                    names.add(name)
                    if row["name"] != name:
                        await conn.execute(
                            update(projects)
                            .where(projects.c.id == row["id"])
                            .values(
                                name=name,
                                updated_at=utc_now(),
                            )
                        )
                        dashboard_changed = True
                active.add(row["id"])
                next_workspaces[workspace.id] = {
                    "path": path,
                    "projectId": row["id"],
                    "roots": roots,
                }
                for session_id in workspace.sessionIds:
                    members[session_id] = workspace.id
            removed = [
                pid
                for pid in managed - active
                if by_id.get(pid, {}).get("manually_created")
            ]
            if removed:
                await conn.execute(
                    update(projects)
                    .where(projects.c.id.in_(removed))
                    .values(manually_created=False)
                )
                dashboard_changed = True
            tracked = (
                set(previous.get("trackedSessionIds", []))
                | previous.get("members", {}).keys()
                | members.keys()
            )
            rows = (
                await conn.execute(
                    select(
                        sessions.c.id,
                        sessions.c.project_id,
                        sessions.c.external_session_id,
                    ).where(
                        sessions.c.connector_id == connector_id,
                        sessions.c.runtime_id == runtime_id,
                        sessions.c.runtime == runtime,
                    )
                )
            ).all()
            assignments: dict[str, tuple[str | None, str | None]] = {}
            for row in rows:
                workspace = next_workspaces.get(members.get(row.external_session_id))
                if workspace is not None:
                    target = workspace["projectId"]
                elif (
                    inventory.membershipScope == "runtime"
                    or row.external_session_id in tracked
                ):
                    target = None
                else:
                    continue  # cwd-only legacy sessions remain under their existing management.
                if row.project_id != target:
                    assignments[str(row.id)] = (target, row.external_session_id)
            pending = sorted(
                set(previous.get("pendingSessionIds", [])) | assignments.keys()
            )
            state = {
                "workspaces": next_workspaces,
                "members": members,
                "managedProjectIds": sorted(managed),
                "membershipScope": inventory.membershipScope,
                "trackedSessionIds": sorted(tracked)
                if inventory.membershipScope == "tracked"
                else [],
                "fingerprint": fingerprint,
                "applicationComplete": False,
                "pendingSessionIds": pending,
                "pendingDashboardChanged": dashboard_changed,
            }
            values = {
                "snapshot_id": inventory.snapshotId,
                "observed_at": observed_at,
                "snapshot_json": json.dumps(state),
            }
            if prior:
                await conn.execute(
                    update(runtime_workspace_inventories).where(*key).values(**values)
                )
            else:
                await conn.execute(
                    insert(runtime_workspace_inventories).values(
                        connector_id=connector_id,
                        runtime_id=runtime_id,
                        **values,
                    )
                )

        # No device write lock is held while waiting for session revision
        # fences. Each changed session checks the small snapshot ID under the
        # device share lock; a newer snapshot cannot race an obsolete write.
        for session_id, (project_id, external_id) in assignments.items():
            try:
                await self._apply_workspace_assignment(
                    session_id=session_id,
                    connector_id=connector_id,
                    runtime_id=runtime_id,
                    snapshot_id=inventory.snapshotId,
                    project_id=project_id,
                    external_id=external_id,
                )
            except _WorkspaceSnapshotSuperseded:
                return WorkspaceSyncResult()
            except KeyError:
                continue
        async with self._engine.begin() as conn:
            await conn.execute(
                select(connectors.c.id)
                .where(
                    connectors.c.id == connector_id,
                )
                .with_for_update()
            )
            current = (
                (await conn.execute(select(runtime_workspace_inventories).where(*key)))
                .mappings()
                .first()
            )
            if current is None or current["snapshot_id"] != inventory.snapshotId:
                return WorkspaceSyncResult()
            # AA name claims may have changed the stored ownership while the
            # session stage ran. Preserve them rather than rewriting old state.
            state = json.loads(current["snapshot_json"])
            pending = state.get("pendingSessionIds", [])
            dashboard_changed = bool(state.get("pendingDashboardChanged")) or bool(
                pending
            )
            state.update(
                applicationComplete=True,
                pendingSessionIds=[],
                pendingDashboardChanged=False,
            )
            await conn.execute(
                update(runtime_workspace_inventories)
                .where(*key)
                .values(snapshot_json=json.dumps(state))
            )
        return WorkspaceSyncResult(
            session_ids=pending, dashboard_changed=dashboard_changed
        )

    @session_revision_fenced
    async def _apply_workspace_assignment(
        self,
        *,
        session_id: str,
        connector_id: str,
        runtime_id: str,
        snapshot_id: str,
        project_id: str | None,
        external_id: str | None,
    ) -> SessionView:
        async with self._engine.begin() as conn:
            connector = (
                await conn.execute(
                    select(connectors.c.id)
                    .where(
                        connectors.c.id == connector_id,
                        connectors.c.revoked == 0,
                    )
                    .with_for_update(read=True)
                )
            ).first()
            if connector is None:
                raise KeyError(connector_id)
            current_id = (
                await conn.execute(
                    select(runtime_workspace_inventories.c.snapshot_id).where(
                        runtime_workspace_inventories.c.connector_id == connector_id,
                        runtime_workspace_inventories.c.runtime_id == runtime_id,
                    )
                )
            ).scalar_one_or_none()
            if current_id != snapshot_id:
                raise _WorkspaceSnapshotSuperseded()
            row = (
                await conn.execute(
                    select(
                        sessions.c.project_id,
                        sessions.c.external_session_id,
                    ).where(
                        sessions.c.id == session_id,
                        sessions.c.connector_id == connector_id,
                        sessions.c.runtime_id == runtime_id,
                    )
                )
            ).first()
            if row is None:
                raise KeyError(session_id)
            if row.external_session_id != external_id:
                raise ValueError(
                    "session identity changed during workspace reconciliation; retry"
                )
            if row.project_id != project_id:
                await self._bump_session(conn, session_id)
                await conn.execute(
                    update(sessions)
                    .where(sessions.c.id == session_id)
                    .values(project_id=project_id)
                )
        return await self.get_session(session_id)
