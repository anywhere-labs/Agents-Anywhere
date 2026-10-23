"""Project projections from current native facts; no historical membership blacklist."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import secrets
from typing import Any

from loguru import logger
from sqlalchemy import insert, select, update

from agent_server.core.utc import utc_now
from agent_server.core.workspace_inventory import (
    RuntimeWorkspaceInventory,
    WorkspaceInventoryChunk,
    WorkspaceSyncResult,
)
from agent_server.infra.db import (
    connectors,
    device_runtimes,
    projects,
    runtime_workspace_inventories,
    sessions,
)
from agent_server.infra.repositories.projects import _clean_workspace_path
from agent_server.infra.repositories.store_support import session_revision_fenced


class _WorkspaceSnapshotSuperseded(RuntimeError):
    pass


def _assignment(
    state: dict[str, Any], external_id: str | None, cwd: str, current: str | None
) -> tuple[str | None, str | None, str | None]:
    """Unknown observations retain the last effective assignment."""
    member = state.get("members", {}).get(external_id)
    if member is None:
        return None, None, "no_native_membership"
    native_id = member.get("projectId")
    if native_id is None:
        return None, None, "no_native_membership"
    workspace = state.get("workspaces", {}).get(native_id)
    if workspace is None:
        return None, native_id, "native_project_missing"
    directory_states = state.get("directories", {})
    unknown = set(state.get("unknownDirectories", []))

    def current_directory(path: str) -> str:
        if not path:
            return "unknown"
        key = _clean_workspace_path(path, None)[1]
        return "unknown" if key in unknown else directory_states.get(key, "unknown")

    roots = [current_directory(root) for root in workspace["roots"]]
    if roots and all(value == "missing" for value in roots):
        return None, native_id, "project_directory_missing"
    path_state = current_directory(cwd)
    if path_state == "missing":
        return None, native_id, "session_directory_missing"
    if path_state != "present" or not any(value == "present" for value in roots):
        return current, native_id, "directory_unknown"
    return workspace["projectId"], native_id, None


class WorkspaceRepositoryMixin:
    async def collect_workspace_chunk(
        self,
        *,
        connector_id: str,
        runtime_id: str,
        runtime: str,
        chunk: WorkspaceInventoryChunk,
    ) -> dict[str, Any] | WorkspaceSyncResult | None:
        key = (
            runtime_workspace_inventories.c.connector_id == connector_id,
            runtime_workspace_inventories.c.runtime_id == runtime_id,
        )
        async with self._engine.begin() as conn:
            epoch = (
                await conn.execute(
                    select(connectors.c.workspace_epoch)
                    .where(connectors.c.id == connector_id, connectors.c.revoked == 0)
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if epoch != chunk.epoch:
                raise ValueError("obsolete workspace connection")
            source = (
                await conn.execute(
                    select(device_runtimes.c.runtime_type).where(
                        device_runtimes.c.connector_id == connector_id,
                        device_runtimes.c.runtime_id == runtime_id,
                        device_runtimes.c.config_json.is_not(None),
                    )
                )
            ).scalar_one_or_none()
            if source != runtime:
                raise ValueError("unbound workspace source")
            prior = (
                (await conn.execute(select(runtime_workspace_inventories).where(*key)))
                .mappings()
                .first()
            )
            state = json.loads(prior["snapshot_json"]) if prior else {}
            sequence = (
                state.get("sequence", 0) if state.get("epoch") == chunk.epoch else 0
            )
            if chunk.sequence < sequence:
                return WorkspaceSyncResult()
            if chunk.sequence == sequence and prior:
                if prior["snapshot_id"] != chunk.snapshotId:
                    raise ValueError("workspace sequence reused")
                if state.get("applicationComplete"):
                    return WorkspaceSyncResult(
                        session_ids=state.get("pendingSessionIds", []),
                        dashboard_changed=bool(state.get("pendingDashboardChanged")),
                    )
            incoming = state.get("incoming", {})
            if (
                incoming.get("epoch") == chunk.epoch
                and incoming.get("sequence", 0) > chunk.sequence
            ):
                return WorkspaceSyncResult()
            identity = chunk.model_dump(exclude={"index", "data"})
            if incoming.get("snapshotId") != chunk.snapshotId:
                incoming = {**identity, "parts": {}}
            elif any(incoming.get(k) != v for k, v in identity.items()):
                raise ValueError("workspace chunk metadata changed")
            part = str(chunk.index)
            if part in incoming["parts"] and incoming["parts"][part] != chunk.data:
                raise ValueError("workspace chunk contents changed")
            incoming["parts"][part] = chunk.data
            state["incoming"] = incoming
            if prior:
                await conn.execute(
                    update(runtime_workspace_inventories)
                    .where(*key)
                    .values(snapshot_json=json.dumps(state))
                )
            else:
                await conn.execute(
                    insert(runtime_workspace_inventories).values(
                        connector_id=connector_id,
                        runtime_id=runtime_id,
                        snapshot_id=chunk.snapshotId,
                        observed_at="",
                        snapshot_json=json.dumps(state),
                    )
                )
            if len(incoming["parts"]) != chunk.count:
                return None
            raw = b"".join(
                base64.b64decode(incoming["parts"][str(i)], validate=True)
                for i in range(chunk.count)
            )
            if hashlib.sha256(raw).hexdigest() != chunk.digest:
                raise ValueError("workspace snapshot digest mismatch")
            payload = json.loads(raw)
            if any(
                payload.get(k) != v
                for k, v in {
                    "epoch": chunk.epoch,
                    "sequence": chunk.sequence,
                    "snapshotId": chunk.snapshotId,
                    "runtime": runtime,
                    "runtimeId": runtime_id,
                }.items()
            ):
                raise ValueError("workspace snapshot identity mismatch")
            return payload

    async def mark_workspace_source_unavailable(
        self, *, connector_id: str, runtime_id: str, runtime: str, epoch: str
    ) -> bool:
        async with self._engine.begin() as conn:
            current_epoch = (
                await conn.execute(
                    select(connectors.c.workspace_epoch)
                    .where(connectors.c.id == connector_id, connectors.c.revoked == 0)
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if current_epoch != epoch:
                raise ValueError("obsolete workspace connection")
            source = (
                await conn.execute(
                    select(device_runtimes.c.runtime_type).where(
                        device_runtimes.c.connector_id == connector_id,
                        device_runtimes.c.runtime_id == runtime_id,
                        device_runtimes.c.config_json.is_not(None),
                    )
                )
            ).scalar_one_or_none()
            if source != runtime:
                raise ValueError("unbound workspace source")
            key = (
                runtime_workspace_inventories.c.connector_id == connector_id,
                runtime_workspace_inventories.c.runtime_id == runtime_id,
            )
            raw = (
                await conn.execute(
                    select(runtime_workspace_inventories.c.snapshot_json).where(*key)
                )
            ).scalar_one_or_none()
            if raw is None:
                return False
            state = json.loads(raw)
            if state.get("syncUnavailable"):
                return False
            state["syncUnavailable"] = True
            await conn.execute(
                update(runtime_workspace_inventories)
                .where(*key)
                .values(snapshot_json=json.dumps(state))
            )
            await conn.execute(
                update(projects)
                .where(
                    projects.c.connector_id == connector_id,
                    projects.c.runtime_id == runtime_id,
                    projects.c.source_state == "active",
                )
                .values(source_state="unknown")
            )
            return True

    async def issue_workspace_epoch(
        self, connector_id: str, *, epoch: str | None = None
    ) -> str:
        epoch = epoch or secrets.token_urlsafe(24)
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(connectors)
                .where(
                    connectors.c.id == connector_id,
                    connectors.c.revoked == 0,
                )
                .values(workspace_epoch=epoch)
            )
            if not result.rowcount:
                raise KeyError(connector_id)
        return epoch

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
    ) -> tuple[str | None, str | None, str | None, str | None]:
        device_os = (
            await conn.execute(
                select(connectors.c.device_os)
                .where(
                    connectors.c.id == connector_id,
                    connectors.c.revoked == 0,
                )
                .with_for_update(read=True)
            )
        ).first()
        if device_os is None:
            raise KeyError(connector_id)
        cwd = (
            _clean_workspace_path(workspace_path, device_os[0])[0]
            if workspace_path
            else None
        )
        raw = (
            await conn.execute(
                select(runtime_workspace_inventories.c.snapshot_json).where(
                    runtime_workspace_inventories.c.connector_id == connector_id,
                    runtime_workspace_inventories.c.runtime_id == runtime_id,
                )
            )
        ).scalar_one_or_none()
        current = None
        if external_session_id:
            current = (
                await conn.execute(
                    select(sessions.c.project_id)
                    .where(
                        sessions.c.connector_id == connector_id,
                        sessions.c.runtime_id == runtime_id,
                        sessions.c.external_session_id == external_session_id,
                    )
                    .limit(1)
                )
            ).scalar_one_or_none()
        state = json.loads(raw) if raw else {}
        if state.get("version") != 2:
            # Existing legacy bindings freeze until the first complete native read.
            # Newly discovered sessions remain ungrouped; cwd never creates a project.
            return current, cwd, None, "awaiting_native_inventory"
        project_id, native_id, reason = _assignment(
            state, external_session_id, cwd or "", current
        )
        return project_id, cwd, native_id, reason

    async def sync_runtime_workspaces(
        self,
        *,
        connector_id: str,
        runtime_id: str,
        inventory: RuntimeWorkspaceInventory,
        runtime: str,
    ) -> WorkspaceSyncResult:
        key = (
            runtime_workspace_inventories.c.connector_id == connector_id,
            runtime_workspace_inventories.c.runtime_id == runtime_id,
        )
        async with self._engine.begin() as conn:
            connector = (
                (
                    await conn.execute(
                        select(connectors)
                        .where(
                            connectors.c.id == connector_id,
                            connectors.c.revoked == 0,
                        )
                        .with_for_update()
                    )
                )
                .mappings()
                .first()
            )
            if connector is None:
                raise KeyError(connector_id)
            if connector["workspace_epoch"] != inventory.epoch:
                raise ValueError("workspace snapshot belongs to an obsolete connection")
            source = (
                await conn.execute(
                    select(
                        device_runtimes.c.runtime_type, device_runtimes.c.config_json
                    ).where(
                        device_runtimes.c.connector_id == connector_id,
                        device_runtimes.c.runtime_id == runtime_id,
                    )
                )
            ).first()
            if (
                source is None
                or source.runtime_type != runtime
                or source.config_json is None
            ):
                raise ValueError(
                    "workspace source is not a configured Runtime instance on this device"
                )
            prior = (
                (await conn.execute(select(runtime_workspace_inventories).where(*key)))
                .mappings()
                .first()
            )
            previous = json.loads(prior["snapshot_json"]) if prior else {}
            old_sequence = (
                previous.get("sequence", 0)
                if previous.get("epoch") == inventory.epoch
                else 0
            )
            if inventory.sequence < old_sequence:
                return WorkspaceSyncResult()
            if (
                inventory.sequence == old_sequence
                and prior
                and prior["snapshot_id"] != inventory.snapshotId
            ):
                raise ValueError("workspace sequence was reused")
            activated = previous.get("version") == 2
            if not activated and not (
                inventory.catalogComplete and inventory.membersComplete
            ):
                return WorkspaceSyncResult()
            old_workspaces = previous.get("workspaces", {}) if activated else {}
            workspaces = dict(old_workspaces)
            if inventory.catalogComplete:
                workspaces = {}
                for workspace in inventory.workspaces:
                    path, path_key = _clean_workspace_path(
                        workspace.path, connector["device_os"]
                    )
                    roots = [
                        _clean_workspace_path(root, connector["device_os"])[0]
                        for root in workspace.roots
                    ]
                    workspaces[workspace.id] = {
                        "path": path,
                        "pathKey": path_key,
                        "roots": roots,
                        "title": workspace.title,
                        "identityKind": workspace.identityKind,
                    }
            members = dict(previous.get("members", {})) if activated else {}
            if inventory.membersComplete:
                members = {
                    member.sessionId: {
                        "projectId": member.projectId,
                        "cwd": _clean_workspace_path(
                            member.cwd, connector["device_os"]
                        )[0]
                        if member.cwd
                        else None,
                    }
                    for member in inventory.members
                }
            directories = dict(previous.get("directories", {})) if activated else {}
            unknown = (
                set(previous.get("unknownDirectories", [])) if activated else set()
            )
            for observation in inventory.directories:
                path = _clean_workspace_path(observation.path, connector["device_os"])[
                    1
                ]
                if observation.state == "unknown":
                    unknown.add(path)
                else:
                    directories[path] = observation.state
                    unknown.discard(path)
            relevant_paths = {
                _clean_workspace_path(root, None)[1]
                for workspace in workspaces.values()
                for root in workspace["roots"]
            }
            relevant_paths.update(
                _clean_workspace_path(member["cwd"], None)[1]
                for member in members.values()
                if member["cwd"]
            )
            directories = {
                path: value
                for path, value in directories.items()
                if path in relevant_paths
            }
            unknown &= relevant_paths
            # Projection IDs and application progress do not affect the fact fingerprint.
            facts = {
                "workspaces": {
                    wid: {k: v for k, v in ws.items() if k != "projectId"}
                    for wid, ws in workspaces.items()
                },
                "members": members,
                "directories": directories,
                "unknownDirectories": sorted(unknown),
            }
            fingerprint = hashlib.sha256(
                json.dumps(facts, sort_keys=True).encode()
            ).hexdigest()
            if (
                inventory.sequence == old_sequence
                and previous.get("fingerprint") != fingerprint
            ):
                raise ValueError("snapshot sequence was reused with different contents")
            if (
                previous.get("fingerprint") == fingerprint
                and previous.get("applicationComplete")
                and previous.get("projectionVersion") == 3
                and not previous.get("syncUnavailable")
            ):
                previous.pop("incoming", None)
                previous.update(epoch=inventory.epoch, sequence=inventory.sequence)
                await conn.execute(
                    update(runtime_workspace_inventories)
                    .where(*key)
                    .values(
                        snapshot_id=inventory.snapshotId,
                        observed_at=inventory.observedAt.isoformat(),
                        snapshot_json=json.dumps(previous),
                    )
                )
                return WorkspaceSyncResult(
                    session_ids=previous.get("pendingSessionIds", []),
                    dashboard_changed=bool(previous.get("pendingDashboardChanged")),
                )
            native_rows = (
                (
                    await conn.execute(
                        select(projects).where(
                            projects.c.connector_id == connector_id,
                            projects.c.runtime_id == runtime_id,
                        )
                    )
                )
                .mappings()
                .all()
            )
            by_native = {row["native_project_id"]: row for row in native_rows}
            legacy = (
                (
                    await conn.execute(
                        select(projects).where(
                            projects.c.connector_id == connector_id,
                            projects.c.identity_kind == "legacy",
                        )
                    )
                )
                .mappings()
                .all()
            )
            legacy_pins = {row["workspace_key"] for row in legacy if row["pinned"]}
            dashboard_changed = bool(previous.get("pendingDashboardChanged"))
            for native_id, workspace in workspaces.items():
                row = by_native.get(native_id)
                root_states = [
                    directories.get(_clean_workspace_path(root, None)[1], "unknown")
                    for root in workspace["roots"]
                ]
                source_state = (
                    "active"
                    if any(value == "present" and _clean_workspace_path(root, None)[1] not in unknown
                           for root, value in zip(workspace["roots"], root_states, strict=True))
                    else "missing"
                    if all(value == "missing" for value in root_states) and not any(
                        _clean_workspace_path(root, None)[1] in unknown for root in workspace["roots"])
                    else "unknown"
                )
                values = {
                    "name": workspace["title"],
                    "workspace_path": workspace["path"],
                    "workspace_key": workspace["pathKey"],
                    "roots_json": json.dumps(workspace["roots"]),
                    "source_state": source_state,
                    "identity_kind": workspace["identityKind"],
                    "manually_created": False,
                }
                if row is None:
                    project_id = f"proj_{secrets.token_urlsafe(10)}"
                    await conn.execute(
                        insert(projects).values(
                            id=project_id,
                            user_id=connector["user_id"],
                            connector_id=connector_id,
                            runtime=runtime,
                            runtime_id=runtime_id,
                            native_project_id=native_id,
                            pinned=int(workspace["pathKey"] in legacy_pins),
                            created_at=utc_now(),
                            updated_at=utc_now(),
                            **values,
                        )
                    )
                    dashboard_changed = True
                else:
                    project_id = row["id"]
                    if any(row.get(k) != v for k, v in values.items()):
                        await conn.execute(
                            update(projects)
                            .where(projects.c.id == project_id)
                            .values(**values, updated_at=utc_now())
                        )
                        dashboard_changed = True
                workspace["projectId"] = project_id
            for native_id, row in by_native.items():
                if native_id not in workspaces and row["source_state"] != "historical":
                    await conn.execute(
                        update(projects)
                        .where(projects.c.id == row["id"])
                        .values(source_state="historical", updated_at=utc_now())
                    )
                    dashboard_changed = True
            state = {
                **facts,
                "workspaces": workspaces,
                "version": 2,
                "epoch": inventory.epoch,
                "sequence": inventory.sequence,
                "fingerprint": fingerprint,
                "applicationComplete": False,
                "projectionVersion": 3,
                "pendingDashboardChanged": dashboard_changed,
            }
            rows = (
                await conn.execute(
                    select(
                        sessions.c.id,
                        sessions.c.external_session_id,
                        sessions.c.project_id,
                        sessions.c.cwd,
                        sessions.c.native_project_id,
                        sessions.c.project_sync_reason,
                    ).where(
                        sessions.c.connector_id == connector_id,
                        sessions.c.runtime_id == runtime_id,
                        sessions.c.runtime == runtime,
                        sessions.c.external_session_id.is_not(None),
                    )
                )
            ).all()
            assignments = {}
            for row in rows:
                cwd = (
                    _clean_workspace_path(row.cwd, connector["device_os"])[0]
                    if row.cwd
                    else ""
                )
                target = _assignment(
                    state, row.external_session_id, cwd, row.project_id
                )
                if target != (
                    row.project_id,
                    row.native_project_id,
                    row.project_sync_reason,
                ):
                    assignments[row.id] = row.external_session_id
            logger.info(
                "workspace projection source={} projects={} members={} changed_sessions={} initial={}",
                runtime_id,
                len(workspaces),
                len(members),
                len(assignments),
                not activated,
            )
            pending = sorted(
                set(previous.get("pendingSessionIds", [])) | assignments.keys()
            )
            state["pendingSessionIds"] = pending
            values = {
                "snapshot_id": inventory.snapshotId,
                "observed_at": inventory.observedAt.isoformat(),
                "snapshot_json": json.dumps(state),
            }
            if prior:
                await conn.execute(
                    update(runtime_workspace_inventories).where(*key).values(**values)
                )
            else:
                await conn.execute(
                    insert(runtime_workspace_inventories).values(
                        connector_id=connector_id, runtime_id=runtime_id, **values
                    )
                )

        async def apply_one(session_id: str, external_id: str) -> None:
            try:
                await self._apply_workspace_assignment(
                    session_id=session_id,
                    connector_id=connector_id,
                    runtime_id=runtime_id,
                    epoch=inventory.epoch,
                    snapshot_id=inventory.snapshotId,
                    state=state,
                    external_id=external_id,
                )
            except KeyError:
                pass

        # Each session retains its existing revision fence. Bound fan-out to the
        # DB pool; drain the whole batch before propagating a retryable failure.
        entries = list(assignments.items())
        for offset in range(0, len(entries), 8):
            results = await asyncio.gather(
                *(
                    apply_one(sid, target)
                    for sid, target in entries[offset : offset + 8]
                ),
                return_exceptions=True,
            )
            for result in results:
                if isinstance(result, _WorkspaceSnapshotSuperseded):
                    return WorkspaceSyncResult()
                if isinstance(result, BaseException):
                    raise result
        async with self._engine.begin() as conn:
            current_epoch = (
                await conn.execute(
                    select(connectors.c.workspace_epoch)
                    .where(connectors.c.id == connector_id)
                    .with_for_update()
                )
            ).scalar_one_or_none()
            if current_epoch != inventory.epoch:
                return WorkspaceSyncResult()
            current = (
                (await conn.execute(select(runtime_workspace_inventories).where(*key)))
                .mappings()
                .first()
            )
            if current is None or current["snapshot_id"] != inventory.snapshotId:
                return WorkspaceSyncResult()
            state = json.loads(current["snapshot_json"])
            pending = state.get("pendingSessionIds", [])
            dashboard_changed = bool(state.get("pendingDashboardChanged")) or bool(
                pending
            )
            state["applicationComplete"] = True
            await conn.execute(
                update(runtime_workspace_inventories)
                .where(*key)
                .values(snapshot_json=json.dumps(state))
            )
            # Historical directory records are retired only after their sessions have moved.
            await conn.execute(
                update(projects)
                .where(
                    projects.c.connector_id == connector_id,
                    projects.c.identity_kind == "legacy",
                    ~select(sessions.c.id)
                    .where(sessions.c.project_id == projects.c.id)
                    .exists(),
                )
                .values(source_state="historical")
            )
        return WorkspaceSyncResult(
            session_ids=pending, dashboard_changed=dashboard_changed
        )

    async def ack_runtime_workspaces(
        self, *, connector_id: str, runtime_id: str, snapshot_id: str
    ) -> None:
        # Clear delivery progress only after session and dashboard notifications
        # have been published. A failed publish can replay without SQL session writes.
        async with self._engine.begin() as conn:
            await conn.execute(
                select(connectors.c.id)
                .where(connectors.c.id == connector_id)
                .with_for_update()
            )
            key = (
                runtime_workspace_inventories.c.connector_id == connector_id,
                runtime_workspace_inventories.c.runtime_id == runtime_id,
                runtime_workspace_inventories.c.snapshot_id == snapshot_id,
            )
            raw = (
                await conn.execute(
                    select(runtime_workspace_inventories.c.snapshot_json).where(*key)
                )
            ).scalar_one_or_none()
            if raw is None:
                return
            state = json.loads(raw)
            if not state.get("applicationComplete"):
                return
            state.pop("pendingSessionIds", None)
            state.pop("pendingDashboardChanged", None)
            await conn.execute(
                update(runtime_workspace_inventories)
                .where(*key)
                .values(snapshot_json=json.dumps(state))
            )

    @session_revision_fenced
    async def _apply_workspace_assignment(
        self,
        *,
        session_id: str,
        connector_id: str,
        runtime_id: str,
        epoch: str,
        snapshot_id: str,
        state: dict[str, Any],
        external_id: str | None,
    ) -> None:
        async with self._engine.begin() as conn:
            current_epoch = (
                await conn.execute(
                    select(connectors.c.workspace_epoch)
                    .where(connectors.c.id == connector_id)
                    .with_for_update(read=True)
                )
            ).scalar_one_or_none()
            configured = (await conn.execute(select(device_runtimes.c.runtime_id).where(
                device_runtimes.c.connector_id == connector_id,
                device_runtimes.c.runtime_id == runtime_id,
                device_runtimes.c.config_json.is_not(None),
            ))).first()
            revoked = (await conn.execute(select(connectors.c.revoked).where(connectors.c.id == connector_id))).scalar_one_or_none()
            if current_epoch != epoch or configured is None or revoked != 0:
                raise _WorkspaceSnapshotSuperseded()
            current = (
                await conn.execute(
                    select(runtime_workspace_inventories.c.snapshot_id).where(
                        runtime_workspace_inventories.c.connector_id == connector_id,
                        runtime_workspace_inventories.c.runtime_id == runtime_id,
                    )
                )
            ).scalar_one_or_none()
            if current != snapshot_id:
                raise _WorkspaceSnapshotSuperseded()
            row = (
                await conn.execute(
                    select(
                        sessions.c.external_session_id,
                        sessions.c.cwd,
                        sessions.c.project_id,
                        sessions.c.native_project_id,
                        sessions.c.project_sync_reason,
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
                raise ValueError("session identity changed during reconciliation")
            # Metadata may have changed while earlier sessions were being applied.
            # Compute under the revision fence from the latest cwd and assignment.
            project_id, native_project_id, reason = _assignment(
                state, external_id, row.cwd or "", row.project_id
            )
            if (project_id, native_project_id, reason) == (
                row.project_id,
                row.native_project_id,
                row.project_sync_reason,
            ):
                return
            await self._bump_session(conn, session_id)
            await conn.execute(
                update(sessions)
                .where(sessions.c.id == session_id)
                .values(
                    project_id=project_id,
                    native_project_id=native_project_id,
                    project_sync_reason=reason,
                )
            )
