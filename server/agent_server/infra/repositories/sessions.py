# ruff: noqa: F403, F405, I001

from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy import func

from sqlalchemy import Text, case, literal
from sqlalchemy.dialects.postgresql import insert as pg_insert
from pydantic import BaseModel

from agent_server.infra.db.schema import session_source_change_seq
from agent_server.infra.repositories.store_support import *
from agent_server.infra.repositories.projects import _clean_workspace_path
from agent_server.core.models import ConnectorSessionResolution
from agent_server.infra.db.engine import closing_connection, read_connection


SESSION_CURSOR_VERSION = 1
_SESSION_INVENTORY_UPDATE_CHUNK_SIZE = 4_000
_SESSION_INVENTORY_MISSING_REASON = "not returned by complete inventory"

# Title provenance. A title a user typed must survive every later connector sync,
# because runtimes keep re-announcing the title of their own thread file.
TITLE_SOURCE_CONNECTOR = "connector"
TITLE_SOURCE_USER = "user"


def _normalized_source_availability(value: Any) -> str:
    if value == "visible":
        return "available"
    if value == "hidden":
        return "unavailable"
    if isinstance(value, str) and value in {
        "available",
        "archived",
        "unavailable",
        "deleted",
        "missing",
        "unknown",
    }:
        return value
    return "unknown"


def _next_source_change_seq() -> Any:
    return func.nextval(session_source_change_seq.name)


def _source_changed_since(changed_seq: int | None, started_seq: int) -> bool:
    """Whether a source write followed the start of an inventory scan."""
    return changed_seq is not None and changed_seq >= started_seq


def _source_archive_update(
    previous_source_state: str | None,
    source_state: str | None,
    *,
    archived: bool | int,
    observed_at: str,
) -> dict[str, Any]:
    # Import a newly observed archive once. Repeated observations must not undo
    # a later unarchive in AA. Missing/unavailable observations do not establish
    # a new archive transition, and source recovery must not unarchive AA.
    if (
        source_state == "archived"
        and previous_source_state in {None, "visible", "available"}
        and not archived
    ):
        return {"archived": 1, "archived_at": observed_at, "dsh_archive_legacy": 0}
    return {}


def _session_cursor_values(row: Any) -> tuple[int, str, int, int, str]:
    latest_item_order_seq = row["latest_item_order_seq"]
    return (
        int(row["pinned"] or 0),
        str(row["session_sort_at"] or ""),
        -1 if latest_item_order_seq is None else int(latest_item_order_seq),
        int(row["updated_seq"] or 0),
        str(row["id"]),
    )


def _encode_session_cursor(row: Any) -> str:
    pinned, sort_at, order_seq, updated_seq, session_id = _session_cursor_values(row)
    payload = json.dumps(
        {
            "v": SESSION_CURSOR_VERSION,
            "p": pinned,
            "s": sort_at,
            "o": order_seq,
            "u": updated_seq,
            "i": session_id,
        },
        separators=(",", ":"),
    ).encode("utf-8")
    return base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _decode_session_cursor(cursor: str) -> tuple[int, str, int, int, str]:
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(cursor + padding))
        values = (
            payload["p"],
            payload["s"],
            payload["o"],
            payload["u"],
            payload["i"],
        )
        if payload.get("v") != SESSION_CURSOR_VERSION:
            raise ValueError
        if type(values[0]) is not int or values[0] not in (0, 1):
            raise ValueError
        if not isinstance(values[1], str):
            raise ValueError
        if type(values[2]) is not int or type(values[3]) is not int:
            raise ValueError
        if not isinstance(values[4], str) or not values[4]:
            raise ValueError
        return values
    except (binascii.Error, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise ValueError("invalid session cursor") from exc


def _normalize_session_origin(value: str | None) -> str:
    return "platform" if value == "platform" else "connector_import"


def _selection_map(
    model_selection_id: str | None,
    permission_selection_id: str | None,
) -> dict[str, str]:
    selections: dict[str, str] = {}
    if model_selection_id:
        selections["model"] = model_selection_id
    if permission_selection_id:
        selections["permission"] = permission_selection_id
    return selections


def _runtime_identity(runtime: str, runtime_id: str | None) -> RuntimeIdentity:
    return RuntimeIdentity.create(
        runtime_type=runtime,
        runtime_id=runtime_id or runtime,
    )


def _binding_identity(
    *,
    explicit: Any,
    runtime: str | None,
    runtime_id: str | None,
    source_runtime: str | None,
    source_runtime_id: str | None,
) -> RuntimeIdentity:
    """Pick the runtime identity a connector notification resolves against.

    Mirrors the historical order: explicit params, then the explicit session
    row, then the timeline item's source runtime, then the codex default.
    """

    if runtime is not None:
        return _runtime_identity(runtime, runtime_id)
    if explicit is not None:
        return _runtime_identity(str(explicit.runtime), str(explicit.runtime_id))
    if source_runtime is not None and source_runtime != "platform":
        return _runtime_identity(source_runtime, source_runtime_id)
    return _runtime_identity("codex", None)


def _session_sort_at() -> Any:
    latest_item_time = func.nullif(sessions_t.c.latest_item_time, "")
    last_activity_at = func.nullif(sessions_t.c.last_activity_at, "")
    latest_activity_at = case(
        (latest_item_time.is_(None), last_activity_at),
        (last_activity_at.is_(None), latest_item_time),
        (latest_item_time >= last_activity_at, latest_item_time),
        else_=last_activity_at,
    )
    return func.coalesce(
        latest_activity_at,
        sessions_t.c.sort_at,
        sessions_t.c.created_at,
    )


def _has_title(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _session_view_query() -> Any:
    """Select session rows with the columns ``_session_from_row`` reads.

    The newest timeline row's summary (``latest_item_*``) is stored on the
    session by every timeline write, so listing sessions does not touch
    ``timeline_items``.
    """

    return select(
        sessions_t,
        connectors_t.c.status.label("connector_status"),
        device_runtimes_t.c.name.label("runtime_name"),
        connector_runtime_types_t.c.display_name.label("runtime_type_display_name"),
        _session_sort_at().label("session_sort_at"),
    ).select_from(
        sessions_t.join(
            connectors_t,
            connectors_t.c.id == sessions_t.c.connector_id,
        )
        .outerjoin(
            device_runtimes_t,
            (device_runtimes_t.c.connector_id == sessions_t.c.connector_id)
            & (device_runtimes_t.c.runtime_id == sessions_t.c.runtime_id),
        )
        .outerjoin(
            connector_runtime_types_t,
            (connector_runtime_types_t.c.connector_id == sessions_t.c.connector_id)
            & (connector_runtime_types_t.c.runtime_type == sessions_t.c.runtime),
        )
    )


class SessionRepositoryMixin:
    async def get_session_runtime(self, session_id: str) -> str | None:
        async with read_connection(self._engine) as conn:
            row = (
                await conn.execute(
                    select(sessions_t.c.runtime).where(sessions_t.c.id == session_id)
                )
            ).first()
        return None if row is None else str(row.runtime)

    async def create_session(
        self,
        *,
        connector_id: str,
        project_id: str | None = None,
        user_id: str | None = None,
        runtime: str,
        runtime_id: str | None = None,
        external_session_id: str | None,
        title: str | None,
        cwd: str | None,
        model_selection_id: str | None = None,
        permission_selection_id: str | None = None,
        selections: dict[str, str | None] | None = None,
        takeover: bool = False,
        session_id: str | None = None,
    ) -> SessionView:
        identity = _runtime_identity(runtime, runtime_id)
        has_reserved_id = session_id is not None
        session_id = session_id or f"sess_{secrets.token_urlsafe(10)}"
        now = utc_now()
        async with self._engine.begin() as conn:
            if has_reserved_id:
                await conn.execute(select(func.pg_advisory_xact_lock(func.hashtextextended(session_id, 0))))
            connector_q = select(
                connectors_t.c.status,
                connectors_t.c.user_id,
                connectors_t.c.device_os,
            ).where(
                connectors_t.c.id == connector_id, connectors_t.c.revoked == 0
            )
            if user_id is not None:
                connector_q = connector_q.where(connectors_t.c.user_id == user_id)
            connector = (await conn.execute(connector_q)).first()
            if connector is None:
                raise KeyError(connector_id)
            if not project_id:
                raise ValueError("project_id is required for every session")
            project_q = select(
                projects_t.c.connector_id,
                projects_t.c.user_id,
                projects_t.c.workspace_path,
                projects_t.c.workspace_key,
            ).where(projects_t.c.id == project_id)
            if user_id is not None:
                project_q = project_q.where(projects_t.c.user_id == user_id)
            project = (await conn.execute(project_q)).first()
            if project is None:
                raise KeyError(project_id)
            if project.connector_id != connector_id:
                raise ValueError("project connector and workspace must match the session")
            if cwd is None:
                cwd = project.workspace_path
            else:
                cleaned_cwd, cwd_key = _clean_workspace_path(
                    cwd,
                    connector.device_os,
                )
                if cwd_key != project.workspace_key:
                    raise ValueError(
                        "project connector and workspace must match the session"
                    )
                cwd = project.workspace_path or cleaned_cwd
            existing = (await conn.execute(select(sessions_t).where(sessions_t.c.id == session_id))).mappings().first()
            if existing:
                if existing["connector_id"] != connector_id or existing["project_id"] != project_id or existing["runtime_id"] != str(identity.runtime_id):
                    raise ValueError("session identity conflict")
            else:
                await conn.execute(
                    insert(sessions_t).values(
                    id=session_id,
                    connector_id=connector_id,
                    project_id=project_id,
                    runtime=str(identity.runtime_type),
                    runtime_id=str(identity.runtime_id),
                    origin="platform",
                    model_selection_id=model_selection_id,
                    permission_selection_id=permission_selection_id,
                    external_session_id=external_session_id,
                    title=_client_session_title(title),
                    cwd=cwd,
                    status="idle",
                    takeover=int(takeover),
                    sort_at=now,
                    seq=0,
                    seq_allocated_high=0,
                    updated_seq=0,
                    created_at=now,
                    updated_at=now,
                )
            )
        return await self.get_session(session_id)

    async def discard_unstarted_session(self, session_id: str) -> bool:
        """Roll back only our empty allocation after a proven pre-admission refusal."""
        async with closing_connection(self._engine, write=True) as conn:
            result = await conn.execute(
                delete(sessions_t).where(
                    sessions_t.c.id == session_id,
                    sessions_t.c.origin == "platform",
                    sessions_t.c.external_session_id.is_(None),
                    sessions_t.c.seq == 0,
                    ~select(timeline_items_t.c.session_id)
                    .where(timeline_items_t.c.session_id == session_id).exists(),
                ).returning(sessions_t.c.id)
            )
            return result.scalar_one_or_none() is not None

    async def upsert_connector_session(
        self,
        *,
        connector_id: str,
        session_id: str,
        runtime: str,
        runtime_id: str | None = None,
        external_session_id: str | None,
        title: str | None = None,
        cwd: str | None = None,
        status: str | None = None,
        last_synced_at: str | None = None,
        source_observed_at: str | None = None,
        last_activity_at: str | None = None,
        model_selection_id: str | None = None,
        permission_selection_id: str | None = None,
        origin: str = "connector_import",
        source_state: str | None = None,
    ) -> SessionView:
        identity = _runtime_identity(runtime, runtime_id)
        canonical_session_id = session_id
        async with read_connection(self._engine) as conn:
            existing = (
                await conn.execute(
                    select(sessions_t.c.id).where(sessions_t.c.id == session_id)
                )
            ).first()
            if existing is None and external_session_id is not None:
                existing = (
                    await conn.execute(
                        select(sessions_t.c.id)
                        .where(
                            sessions_t.c.connector_id == connector_id,
                            sessions_t.c.runtime_id == str(identity.runtime_id),
                            sessions_t.c.external_session_id == external_session_id,
                        )
                        .order_by(
                            sessions_t.c.takeover.desc(),
                            sessions_t.c.created_at.asc(),
                        )
                        .limit(1)
                    )
                ).first()
            if existing is not None:
                canonical_session_id = str(existing.id)
        return await self._upsert_connector_session_canonical(
            connector_id=connector_id,
            session_id=canonical_session_id,
            runtime=runtime,
            runtime_id=runtime_id,
            external_session_id=external_session_id,
            title=title,
            cwd=cwd,
            status=status,
            last_synced_at=last_synced_at,
            source_observed_at=source_observed_at,
            last_activity_at=last_activity_at,
            model_selection_id=model_selection_id,
            permission_selection_id=permission_selection_id,
            origin=origin,
            source_state=source_state,
        )

    @session_revision_fenced
    async def _upsert_connector_session_canonical(
        self,
        *,
        connector_id: str,
        session_id: str,
        runtime: str,
        runtime_id: str | None = None,
        external_session_id: str | None,
        title: str | None = None,
        cwd: str | None = None,
        status: str | None = None,
        last_synced_at: str | None = None,
        source_observed_at: str | None = None,
        last_activity_at: str | None = None,
        model_selection_id: str | None = None,
        permission_selection_id: str | None = None,
        origin: str = "connector_import",
        source_state: str | None = None,
    ) -> SessionView:
        identity = _runtime_identity(runtime, runtime_id)
        runtime = str(identity.runtime_type)
        runtime_id = str(identity.runtime_id)
        has_model_selection_id = model_selection_id is not None
        has_permission_selection_id = permission_selection_id is not None
        now = utc_now()
        normalized_origin = _normalize_session_origin(origin)
        async with closing_connection(self._engine, write=True) as conn:
            connector = (
                await conn.execute(
                    select(
                        connectors_t.c.status,
                        connectors_t.c.user_id,
                        connectors_t.c.device_os,
                    ).where(connectors_t.c.id == connector_id, connectors_t.c.revoked == 0)
                )
            ).first()
            if connector is None:
                raise KeyError(connector_id)
            existing = (
                await conn.execute(
                    select(sessions_t.c.id).where(sessions_t.c.id == session_id)
                )
            ).first()
            if existing is None:
                project_id, normalized_cwd = await self._ensure_project_for_workspace(
                    conn,
                    connector_id=connector_id,
                    workspace_path=cwd,
                    now=now,
                )
                await conn.execute(
                    insert(sessions_t).values(
                        id=session_id,
                        connector_id=connector_id,
                        project_id=project_id,
                        runtime=runtime,
                        runtime_id=runtime_id,
                        origin=normalized_origin,
                        model_selection_id=model_selection_id,
                        permission_selection_id=permission_selection_id,
                        external_session_id=external_session_id,
                        title=title,
                        title_source=TITLE_SOURCE_CONNECTOR if title is not None else None,
                        cwd=normalized_cwd,
                        status=status or "idle",
                        takeover=0,
                        last_synced_at=last_synced_at,
                        source_observed_at=source_observed_at,
                        last_activity_at=last_activity_at,
                        sort_at=last_activity_at or now,
                        source_state=source_state or "visible",
                        source_state_at=now if source_state is not None else None,
                        seq=1,
                        seq_allocated_high=1,
                        updated_seq=1,
                        created_at=now,
                        updated_at=now,
                        **_source_archive_update(
                            None, source_state, archived=False, observed_at=now
                        ),
                    )
                )
            else:
                current = (
                    await conn.execute(
                        select(
                            sessions_t.c.connector_id,
                            sessions_t.c.runtime,
                            sessions_t.c.runtime_id,
                            sessions_t.c.external_session_id,
                            sessions_t.c.title,
                            sessions_t.c.title_source,
                            sessions_t.c.cwd,
                            sessions_t.c.project_id,
                            sessions_t.c.status,
                            sessions_t.c.model_selection_id,
                            sessions_t.c.permission_selection_id,
                            sessions_t.c.source_state,
                            sessions_t.c.archived,
                            sessions_t.c.dsh_archive_legacy,
                        ).where(sessions_t.c.id == session_id)
                    )
                ).first()
                if current is None:
                    raise KeyError(session_id)
                if current.connector_id != connector_id:
                    raise ValueError("session connector binding is immutable")
                if current.runtime != runtime or current.runtime_id != runtime_id:
                    raise ValueError("session runtime identity is immutable")
                values: dict[str, Any] = {}
                if external_session_id is not None:
                    values["external_session_id"] = external_session_id
                if (
                    title is not None
                    and current.title_source != TITLE_SOURCE_USER
                    and current.title != title
                ):
                    values["title"] = title
                    values["title_source"] = TITLE_SOURCE_CONNECTOR
                if cwd is not None or current.project_id is None:
                    project_id, normalized_cwd = await self._ensure_project_for_workspace(
                        conn,
                        connector_id=connector_id,
                        workspace_path=cwd or current.cwd,
                        now=now,
                    )
                    values["project_id"] = project_id
                    values["cwd"] = normalized_cwd
                if status is not None:
                    values["status"] = status
                if last_synced_at is not None:
                    values["last_synced_at"] = last_synced_at
                if source_observed_at is not None:
                    values["source_observed_at"] = source_observed_at
                if last_activity_at is not None:
                    values["last_activity_at"] = last_activity_at
                if has_model_selection_id:
                    values["model_selection_id"] = model_selection_id
                if has_permission_selection_id:
                    values["permission_selection_id"] = permission_selection_id
                if source_state is not None:
                    values["source_state"] = source_state
                    values["source_state_at"] = now
                    values["source_changed_seq"] = _next_source_change_seq()
                    values.update(
                        _source_archive_update(
                            current.source_state,
                            source_state,
                            archived=current.archived,
                            observed_at=now,
                        )
                    )
                semantic_changed = any(
                    field in values and values[field] != getattr(current, field)
                    for field in (
                        "external_session_id",
                        "title",
                        "cwd",
                        "project_id",
                        "status",
                        "model_selection_id",
                        "permission_selection_id",
                        "source_state",
                        "archived",
                        "dsh_archive_legacy",
                    )
                )
                if semantic_changed:
                    await self._bump_session(conn, session_id)
                await conn.execute(
                    update(sessions_t).where(sessions_t.c.id == session_id).values(**values)
                )
        return await self.get_session(session_id)


    async def resolve_connector_session_id(
        self,
        *,
        connector_id: str,
        session_id: str,
        external_session_id: str | None = None,
        runtime: str | None = None,
        runtime_id: str | None = None,
    ) -> str:
        identity = _runtime_identity(runtime, runtime_id) if runtime is not None else None
        async with read_connection(self._engine) as conn:
            explicit_query = select(
                sessions_t.c.id,
                sessions_t.c.origin,
                sessions_t.c.takeover,
            ).where(
                sessions_t.c.id == session_id,
                sessions_t.c.connector_id == connector_id,
            )
            if identity is not None:
                explicit_query = explicit_query.where(
                    sessions_t.c.runtime == str(identity.runtime_type),
                    sessions_t.c.runtime_id == str(identity.runtime_id),
                )
            explicit = (await conn.execute(explicit_query)).first()
            if explicit is not None and (
                explicit.takeover == 1 or explicit.origin == "platform"
            ):
                return str(explicit.id)
            if external_session_id:
                external_query = select(sessions_t.c.id).where(
                    sessions_t.c.connector_id == connector_id,
                    sessions_t.c.external_session_id == external_session_id,
                )
                if identity is not None:
                    external_query = external_query.where(
                        sessions_t.c.runtime == str(identity.runtime_type),
                        sessions_t.c.runtime_id == str(identity.runtime_id),
                    )
                row = (
                    await conn.execute(
                        external_query
                        .order_by(sessions_t.c.takeover.desc(), sessions_t.c.created_at.asc())
                        .limit(1)
                    )
                ).first()
                if row is not None:
                    return str(row.id)
        if explicit is None:
            raise KeyError(session_id)
        return str(explicit.id)


    async def resolve_connector_session_binding(
        self,
        *,
        connector_id: str,
        session_id: str,
        external_session_id: str | None = None,
        runtime: str | None = None,
        runtime_id: str | None = None,
        source_runtime: str | None = None,
        source_runtime_id: str | None = None,
    ) -> ConnectorSessionResolution:
        """Resolve one connector notification to its session in one connection.

        The streaming ingest path used to make three separate pooled round trips
        for this (runtime identity, canonical session, enabled check). The
        policy is unchanged: a platform or taken-over explicit row wins, then an
        external-session match, otherwise the explicit row.
        """

        async with read_connection(self._engine) as conn:
            explicit = (
                await conn.execute(
                    select(
                        sessions_t.c.id,
                        sessions_t.c.runtime,
                        sessions_t.c.runtime_id,
                        sessions_t.c.origin,
                        sessions_t.c.takeover,
                    ).where(
                        sessions_t.c.id == session_id,
                        sessions_t.c.connector_id == connector_id,
                    )
                )
            ).first()
            identity = _binding_identity(
                explicit=explicit,
                runtime=runtime,
                runtime_id=runtime_id,
                source_runtime=source_runtime,
                source_runtime_id=source_runtime_id,
            )
            resolved_runtime = str(identity.runtime_type)
            resolved_runtime_id = str(identity.runtime_id)
            explicit_matches = explicit is not None and (
                str(explicit.runtime) == resolved_runtime
                and str(explicit.runtime_id) == resolved_runtime_id
            )
            if explicit_matches and (
                explicit.takeover == 1 or explicit.origin == "platform"
            ):
                return ConnectorSessionResolution(
                    sessionId=str(explicit.id),
                    runtime=resolved_runtime,
                    runtimeId=resolved_runtime_id,
                )

            if external_session_id:
                external_query = select(sessions_t.c.id).where(
                    sessions_t.c.connector_id == connector_id,
                    sessions_t.c.external_session_id == external_session_id,
                    sessions_t.c.runtime == resolved_runtime,
                    sessions_t.c.runtime_id == resolved_runtime_id,
                )
                row = (
                    await conn.execute(
                        external_query.order_by(
                            sessions_t.c.takeover.desc(),
                            sessions_t.c.created_at.asc(),
                        ).limit(1)
                    )
                ).first()
                if row is not None:
                    return ConnectorSessionResolution(
                        sessionId=str(row.id),
                        runtime=resolved_runtime,
                        runtimeId=resolved_runtime_id,
                    )

            if explicit_matches:
                return ConnectorSessionResolution(
                    sessionId=str(explicit.id),
                    runtime=resolved_runtime,
                    runtimeId=resolved_runtime_id,
                )

            raw = (
                await conn.execute(
                    select(
                        sessions_t.c.connector_id,
                        sessions_t.c.runtime,
                        sessions_t.c.runtime_id,
                    ).where(sessions_t.c.id == session_id)
                )
            ).first()
            if raw is None:
                return ConnectorSessionResolution(
                    runtime=resolved_runtime,
                    runtimeId=resolved_runtime_id,
                )
            return ConnectorSessionResolution(
                runtime=resolved_runtime,
                runtimeId=resolved_runtime_id,
                boundConnectorId=str(raw.connector_id),
                boundRuntime=str(raw.runtime),
                boundRuntimeId=str(raw.runtime_id),
            )

    async def list_session_inventory(self, *, user_id: str) -> list[SessionView]:
        """Return the owned session metadata used to group the entire workspace."""
        query = (
            _session_view_query()
            .where(connectors_t.c.revoked == 0, connectors_t.c.user_id == user_id)
            .order_by(
                sessions_t.c.pinned.desc(),
                _session_sort_at().desc(),
                func.coalesce(sessions_t.c.latest_item_order_seq, -1).desc(),
                sessions_t.c.updated_seq.desc(),
                sessions_t.c.id.desc(),
            )
        )
        async with read_connection(self._engine) as conn:
            rows = (await conn.execute(query)).mappings().all()
        return await self._sessions_from_rows(rows)

    async def list_sessions_page(
        self,
        *,
        archived: bool,
        limit: int = 100,
        cursor: str | None = None,
        user_id: str | None = None,
        project_id: str | None = None,
    ) -> tuple[list[SessionView], bool, str | None]:
        latest_order_seq = func.coalesce(sessions_t.c.latest_item_order_seq, -1)
        sort_at = _session_sort_at()
        query = (
            _session_view_query()
            .where(
                connectors_t.c.revoked == 0,
                sessions_t.c.archived == int(archived),
            )
            .order_by(
                sessions_t.c.pinned.desc(),
                sort_at.desc(),
                latest_order_seq.desc(),
                sessions_t.c.updated_seq.desc(),
                sessions_t.c.id.desc(),
            )
            .limit(limit + 1)
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        if project_id is not None:
            query = query.where(sessions_t.c.project_id == project_id)
        if cursor:
            pinned, cursor_sort_at, order_seq, updated_seq, session_id = (
                _decode_session_cursor(cursor)
            )
            query = query.where(
                or_(
                    sessions_t.c.pinned < pinned,
                    and_(sessions_t.c.pinned == pinned, sort_at < cursor_sort_at),
                    and_(
                        sessions_t.c.pinned == pinned,
                        sort_at == cursor_sort_at,
                        latest_order_seq < order_seq,
                    ),
                    and_(
                        sessions_t.c.pinned == pinned,
                        sort_at == cursor_sort_at,
                        latest_order_seq == order_seq,
                        sessions_t.c.updated_seq < updated_seq,
                    ),
                    and_(
                        sessions_t.c.pinned == pinned,
                        sort_at == cursor_sort_at,
                        latest_order_seq == order_seq,
                        sessions_t.c.updated_seq == updated_seq,
                        sessions_t.c.id < session_id,
                    ),
                )
            )
        async with read_connection(self._engine) as conn:
            rows = (await conn.execute(query)).mappings().all()
        page_rows = rows[:limit]
        sessions = await self._sessions_from_rows(page_rows)
        has_more = len(rows) > limit
        next_cursor = _encode_session_cursor(page_rows[-1]) if has_more and page_rows else None
        return sessions, has_more, next_cursor

    async def list_sessions(
        self,
        *,
        archived: bool = False,
        limit: int = 100,
        cursor: str | None = None,
        user_id: str | None = None,
        project_id: str | None = None,
    ) -> list[SessionView]:
        sessions, _, _ = await self.list_sessions_page(
            archived=archived,
            limit=limit,
            cursor=cursor,
            user_id=user_id,
            project_id=project_id,
        )
        return sessions

    async def begin_session_inventory(
        self,
        connector_id: str,
        runtime: str,
        runtime_id: str,
        scan_token: str,
    ) -> None:
        """Record one scan row instead of stamping every session of the runtime.

        ``started_seq`` orders the scan against source writes: a session whose
        ``source_changed_seq`` is at or above it moved after the scan began, so
        the scan's older observation must not overwrite it. A notification left
        over from a deleted connector inserts nothing.
        """
        columns = (
            "connector_id",
            "runtime",
            "runtime_id",
            "scan_token",
            "started_seq",
            "started_at",
        )
        statement = pg_insert(session_inventory_scans_t).from_select(
            columns,
            select(
                connectors_t.c.id,
                literal(runtime, Text),
                literal(runtime_id, Text),
                literal(scan_token, Text),
                _next_source_change_seq(),
                literal(utc_now(), Text),
            ).where(connectors_t.c.id == connector_id),
        )
        statement = statement.on_conflict_do_update(
            index_elements=columns[:3],
            set_={
                column: getattr(statement.excluded, column) for column in columns[3:]
            },
        )
        async with self._engine.begin() as conn:
            await conn.execute(statement)

    async def complete_session_inventory(
        self,
        connector_id: str,
        runtime: str,
        runtime_id: str,
        scan_token: str,
        entries: list[dict[str, Any]],
        *,
        complete: bool,
    ) -> list[str]:
        """Apply one scan, writing only the rows the scan actually changes.

        A row whose state, reason and origin all match the observation is left
        alone, so ``source_state_at`` records the last write rather than the last
        scan that confirmed the row.
        """
        now = utc_now()
        changed: list[str] = []
        scan_key = (
            session_inventory_scans_t.c.connector_id == connector_id,
            session_inventory_scans_t.c.runtime == runtime,
            session_inventory_scans_t.c.runtime_id == runtime_id,
            session_inventory_scans_t.c.scan_token == scan_token,
        )
        async with read_connection(self._engine) as conn:
            started_seq = await conn.scalar(
                select(session_inventory_scans_t.c.started_seq).where(*scan_key)
            )
            if started_seq is None:
                # A newer scan replaced this one, or a retry already finished it.
                return changed
            rows = (
                await conn.execute(
                    select(
                        sessions_t.c.id,
                        sessions_t.c.external_session_id,
                        sessions_t.c.source_state,
                        sessions_t.c.source_state_reason,
                        sessions_t.c.source_observation_origin,
                        sessions_t.c.source_changed_seq,
                    ).where(
                        sessions_t.c.connector_id == connector_id,
                        sessions_t.c.runtime == runtime,
                        sessions_t.c.runtime_id == runtime_id,
                    )
                )
            ).mappings().all()

        by_id = {str(row["id"]): row for row in rows}
        by_external_id = {
            str(row["external_session_id"]): row
            for row in rows
            if row["external_session_id"] is not None
        }
        observed_ids: set[str] = set()
        detail_updates: dict[str, dict[str, Any]] = {}
        for entry in entries:
            row = by_id.get(str(entry["session_id"]))
            external_session_id = entry.get("external_session_id")
            if row is None and external_session_id is not None:
                row = by_external_id.get(external_session_id)
            if row is None or _source_changed_since(
                row["source_changed_seq"], started_seq
            ):
                continue
            session_id = str(row["id"])
            observed_ids.add(session_id)
            if row["source_state"] != str(entry["source_state"]):
                if await self._complete_session_inventory_observation(
                    session_id=session_id,
                    started_seq=started_seq,
                    entry=entry,
                    now=now,
                ):
                    changed.append(session_id)
            elif (
                row["source_state_reason"] != entry.get("reason")
                or row["source_observation_origin"] != "inventory"
            ):
                detail_updates[session_id] = entry

        await self._update_session_inventory_details(
            observations=detail_updates,
            started_seq=started_seq,
            now=now,
        )

        if complete:
            stale_missing_ids: list[str] = []
            for row in rows:
                session_id = str(row["id"])
                if session_id in observed_ids or _source_changed_since(
                    row["source_changed_seq"], started_seq
                ):
                    continue
                if row["source_state"] != "missing":
                    if await self._complete_session_inventory_missing(
                        session_id=session_id,
                        started_seq=started_seq,
                        now=now,
                    ):
                        changed.append(session_id)
                elif (
                    row["source_state_reason"] != _SESSION_INVENTORY_MISSING_REASON
                    or row["source_observation_origin"] != "inventory"
                ):
                    stale_missing_ids.append(session_id)
            if stale_missing_ids:
                await self._update_session_inventory_details(
                    observations={
                        session_id: {"reason": _SESSION_INVENTORY_MISSING_REASON}
                        for session_id in stale_missing_ids
                    },
                    started_seq=started_seq,
                    now=now,
                )
        async with self._engine.begin() as conn:
            # Finished last, so a retried batch can repeat an interrupted scan
            # but not a completed one.
            await conn.execute(delete(session_inventory_scans_t).where(*scan_key))
        return changed

    async def _update_session_inventory_details(
        self,
        *,
        observations: dict[str, dict[str, Any]],
        started_seq: int,
        now: str,
    ) -> None:
        """Batch diagnostic observation fields that do not advance revision."""

        if not observations:
            return
        observation_items = list(observations.items())
        async with closing_connection(self._engine, write=True) as conn:
            # Each row contributes up to five bind parameters across the two
            # CASE mappings and the IN predicate.  asyncpg rejects statements
            # with more than 32,767 arguments, so keep ample fixed-parameter
            # and future-query headroom below that driver limit.
            for start in range(
                0,
                len(observation_items),
                _SESSION_INVENTORY_UPDATE_CHUNK_SIZE,
            ):
                chunk = dict(
                    observation_items[
                        start : start + _SESSION_INVENTORY_UPDATE_CHUNK_SIZE
                    ]
                )
                observed_at_by_id = {
                    session_id: entry.get("observed_at") or now
                    for session_id, entry in chunk.items()
                }
                reason_by_id = {
                    session_id: entry.get("reason")
                    for session_id, entry in chunk.items()
                }
                await conn.execute(
                    update(sessions_t)
                    .where(
                        sessions_t.c.id.in_(chunk),
                        or_(
                            sessions_t.c.source_changed_seq.is_(None),
                            sessions_t.c.source_changed_seq < started_seq,
                        ),
                    )
                    .values(
                        source_state_at=case(
                            observed_at_by_id,
                            value=sessions_t.c.id,
                            else_=sessions_t.c.source_state_at,
                        ),
                        source_state_reason=case(
                            reason_by_id,
                            value=sessions_t.c.id,
                            else_=sessions_t.c.source_state_reason,
                        ),
                        source_observation_origin="inventory",
                    )
                )

    async def _complete_session_inventory_observation(
        self,
        *,
        session_id: str,
        started_seq: int,
        entry: dict[str, Any],
        now: str,
    ) -> bool:
        async with self.session_revision_fence(session_id):
            async with closing_connection(self._engine, write=True) as conn:
                row = (
                    await conn.execute(
                        select(
                            sessions_t.c.source_state,
                            sessions_t.c.source_changed_seq,
                            sessions_t.c.archived,
                            sessions_t.c.dsh_archive_legacy,
                        )
                        .where(sessions_t.c.id == session_id)
                        .with_for_update()
                    )
                ).first()
                if row is None or _source_changed_since(
                    row.source_changed_seq, started_seq
                ):
                    return False
                source_state = str(entry["source_state"])
                values: dict[str, Any] = {
                    "source_state": source_state,
                    "source_state_at": entry.get("observed_at") or now,
                    "source_state_reason": entry.get("reason"),
                    "source_observation_origin": "inventory",
                }
                values.update(
                    _source_archive_update(
                        row.source_state,
                        source_state,
                        archived=row.archived,
                        observed_at=entry.get("observed_at") or now,
                    )
                )
                changed = row.source_state != source_state
                if changed:
                    await self._bump_session(conn, session_id)
                await conn.execute(
                    update(sessions_t)
                    .where(sessions_t.c.id == session_id)
                    .values(**values)
                )
            if changed:
                session = await self.get_session(session_id)
                await self.publish_session_revision_result(
                    session_id,
                    operation="complete_session_inventory",
                    result=session,
                )
            return changed

    async def _complete_session_inventory_missing(
        self,
        *,
        session_id: str,
        started_seq: int,
        now: str,
    ) -> bool:
        async with self.session_revision_fence(session_id):
            async with closing_connection(self._engine, write=True) as conn:
                row = (
                    await conn.execute(
                        select(
                            sessions_t.c.source_state,
                            sessions_t.c.source_changed_seq,
                        )
                        .where(sessions_t.c.id == session_id)
                        .with_for_update()
                    )
                ).first()
                if row is None or _source_changed_since(
                    row.source_changed_seq, started_seq
                ):
                    return False
                changed = row.source_state != "missing"
                if changed:
                    await self._bump_session(conn, session_id)
                await conn.execute(
                    update(sessions_t)
                    .where(sessions_t.c.id == session_id)
                    .values(
                        source_state="missing",
                        source_state_at=now,
                        source_state_reason=_SESSION_INVENTORY_MISSING_REASON,
                        source_observation_origin="inventory",
                    )
                )
            if changed:
                session = await self.get_session(session_id)
                await self.publish_session_revision_result(
                    session_id,
                    operation="complete_session_inventory",
                    result=session,
                )
            return changed

    async def refresh_unchanged_session_source(
        self, session_id: str, *, connector_id: str, runtime: str, runtime_id: str,
        availability: str, reason: str | None, observed_at: str | None,
        observation_origin: str,
    ) -> bool:
        """Refresh observation bookkeeping only when semantic fields still match.

        One conditional primary-key UPDATE avoids a SessionView and a revision
        fence for the common unchanged observation. A mismatch takes the normal
        fenced path, including archive transitions and publication.
        """
        observed = observed_at or utc_now()
        stale = sessions_t.c.source_state_at > observed
        async with closing_connection(self._engine, write=True) as conn:
            result = await conn.execute(update(sessions_t).where(
                sessions_t.c.id == session_id,
                sessions_t.c.connector_id == connector_id,
                sessions_t.c.runtime == runtime,
                sessions_t.c.runtime_id == runtime_id,
                sessions_t.c.source_state == availability,
                sessions_t.c.source_state_reason == reason,
                sessions_t.c.source_observation_origin == observation_origin,
            ).values(
                source_state_at=case((stale, sessions_t.c.source_state_at), else_=observed),
                source_changed_seq=case(
                    (stale, sessions_t.c.source_changed_seq),
                    else_=_next_source_change_seq(),
                ),
            ))
            return result.rowcount == 1

    @session_revision_fenced
    async def update_session_source_state(
        self,
        session_id: str,
        *,
        availability: str,
        reason: str | None,
        observed_at: str | None,
        observation_origin: str,
    ) -> SessionView:
        effective_observed_at = observed_at or utc_now()
        async with closing_connection(self._engine, write=True) as conn:
            row = (
                await conn.execute(
                    select(
                        sessions_t.c.source_state,
                        sessions_t.c.source_state_at,
                        sessions_t.c.source_state_reason,
                        sessions_t.c.source_observation_origin,
                        sessions_t.c.runtime,
                        sessions_t.c.archived,
                        sessions_t.c.dsh_archive_legacy,
                    ).where(sessions_t.c.id == session_id)
                )
            ).first()
            if row is None:
                raise KeyError(session_id)
            if row.source_state_at is not None and effective_observed_at < row.source_state_at:
                pass
            else:
                changed = (
                    row.source_state != availability
                    or row.source_state_reason != reason
                    or row.source_observation_origin != observation_origin
                )
                if changed:
                    await self._bump_session(conn, session_id)
                values: dict[str, Any] = {
                    "source_state": availability,
                    "source_state_at": effective_observed_at,
                    "source_state_reason": reason,
                    "source_observation_origin": observation_origin,
                    "source_changed_seq": _next_source_change_seq(),
                }
                values.update(
                    _source_archive_update(
                        row.source_state,
                        availability,
                        archived=row.archived,
                        observed_at=effective_observed_at,
                    )
                )
                await conn.execute(
                    update(sessions_t)
                    .where(sessions_t.c.id == session_id)
                    .values(**values)
                )
        return await self.get_session(session_id)


    async def list_running_sessions_for_connector_agent(
        self,
        *,
        connector_id: str,
        runtime_id: str,
        user_id: str | None = None,
    ) -> list[SessionView]:
        query = (
            _session_view_query()
            .where(
                sessions_t.c.connector_id == connector_id,
                sessions_t.c.runtime_id == runtime_id,
                sessions_t.c.status.in_(
                    (
                        "waiting",
                        "pending",
                        "running",
                        "stopping",
                        "waiting_approval",
                        "error",
                        "blocked",
                    )
                ),
                connectors_t.c.revoked == 0,
            )
            .order_by(sessions_t.c.updated_at.asc())
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with read_connection(self._engine) as conn:
            rows = (await conn.execute(query)).mappings().all()
        return await self._sessions_from_rows(rows)

    async def list_sessions_for_connector(
        self,
        connector_id: str,
    ) -> list[SessionView]:
        query = (
            _session_view_query()
            .where(
                sessions_t.c.connector_id == connector_id,
                connectors_t.c.revoked == 0,
            )
            .order_by(sessions_t.c.created_at.desc())
        )
        async with read_connection(self._engine) as conn:
            rows = (await conn.execute(query)).mappings().all()
        return await self._sessions_from_rows(rows)


    async def get_session_user_id(self, session_id: str) -> str:
        """Resolve notification ownership without reading timeline bodies."""
        query = select(connectors_t.c.user_id).select_from(
            sessions_t.join(connectors_t, sessions_t.c.connector_id == connectors_t.c.id)
        ).where(sessions_t.c.id == session_id, connectors_t.c.revoked == 0)
        async with read_connection(self._engine) as conn:
            row = (await conn.execute(query)).first()
        if row is None:
            raise KeyError(session_id)
        return row.user_id

    async def get_session(self, session_id: str, *, user_id: str | None = None) -> SessionView:
        query = (
            _session_view_query()
            .where(sessions_t.c.id == session_id, connectors_t.c.revoked == 0)
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with read_connection(self._engine) as conn:
            row = (await conn.execute(query)).mappings().first()
        if row is None:
            raise KeyError(session_id)
        return await self._session_from_row(row)


    async def get_session_runtime_state(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> SessionRuntimeState:
        query = (
            select(
                sessions_t.c.id,
                sessions_t.c.runtime,
                sessions_t.c.runtime_id,
                sessions_t.c.external_session_id,
                sessions_t.c.status,
                sessions_t.c.updated_seq,
                sessions_t.c.created_at,
                sessions_t.c.updated_at,
            )
            .join(connectors_t, connectors_t.c.id == sessions_t.c.connector_id)
            .where(sessions_t.c.id == session_id, connectors_t.c.revoked == 0)
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with read_connection(self._engine) as conn:
            row = (await conn.execute(query)).mappings().first()
        if row is None:
            raise KeyError(session_id)
        return SessionRuntimeState(
            sessionId=row["id"],
            runtime=row["runtime"],
            runtimeId=row["runtime_id"],
            externalSessionId=row["external_session_id"],
            status=row["status"],
            selections={},
            updatedSeq=int(row["updated_seq"] or 0),
            createdAt=row["created_at"],
            updatedAt=row["updated_at"],
        )


    async def upsert_session_runtime_state(
        self,
        *,
        session_id: str,
        runtime: str,
        runtime_id: str | None = None,
        external_session_id: str | None = None,
        status: str | None = None,
        selections: dict[str, str | None] | None = None,
        status_reason: str | None = None,
        error: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SessionRuntimeState:
        return await self.get_session_runtime_state(session_id)


    async def session_owned_by_connector(self, session_id: str, connector_id: str) -> bool:
        async with read_connection(self._engine) as conn:
            row = (
                await conn.execute(
                    select(sessions_t.c.id)
                    .join(connectors_t, connectors_t.c.id == sessions_t.c.connector_id)
                    .where(
                        sessions_t.c.id == session_id,
                        sessions_t.c.connector_id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
        return row is not None


    async def get_session_seq(self, session_id: str) -> int:
        async with read_connection(self._engine) as conn:
            row = (
                await conn.execute(
                    select(sessions_t.c.seq).where(sessions_t.c.id == session_id)
                )
            ).first()
        if row is None:
            raise KeyError(session_id)
        return int(row.seq)


    @session_revision_fenced
    async def set_takeover(self, session_id: str, takeover: bool) -> SessionView:
        async with closing_connection(self._engine, write=True) as conn:
            await self._bump_session(conn, session_id)
            await conn.execute(
                update(sessions_t).where(sessions_t.c.id == session_id).values(takeover=int(takeover))
            )
        return await self.get_session(session_id)

    # User-driven metadata mutations skip _bump_session so the row does not
    # flip back to unread the moment the user touches it themselves.


    async def set_session_pinned(
        self,
        session_id: str,
        pinned: bool,
        *,
        user_id: str | None = None,
    ) -> SessionView:
        await self.get_session(session_id, user_id=user_id)
        now = utc_now()
        async with closing_connection(self._engine, write=True) as conn:
            await conn.execute(
                update(sessions_t)
                .where(sessions_t.c.id == session_id)
                .values(
                    pinned=int(bool(pinned)),
                    pinned_at=now if pinned else None,
                    updated_at=now,
                )
            )
        return await self.get_session(session_id, user_id=user_id)


    async def set_session_archived(
        self,
        session_id: str,
        archived: bool,
        *,
        user_id: str | None = None,
    ) -> SessionView:
        await self.get_session(session_id, user_id=user_id)
        now = utc_now()
        async with closing_connection(self._engine, write=True) as conn:
            await conn.execute(
                update(sessions_t)
                .where(sessions_t.c.id == session_id)
                .values(**_manual_archive_values(archived=archived, now=now))
            )
        return await self.get_session(session_id, user_id=user_id)


    async def bulk_set_session_archived(
        self,
        session_ids: list[str],
        archived: bool,
        *,
        user_id: str | None = None,
    ) -> tuple[list[SessionView], list[str]]:
        # Dedupe while preserving caller order.
        seen: set[str] = set()
        ordered: list[str] = []
        for sid in session_ids:
            if sid not in seen:
                seen.add(sid)
                ordered.append(sid)
        if not ordered:
            return [], []

        now = utc_now()
        owned_query = (
            select(sessions_t.c.id)
            .join(connectors_t, connectors_t.c.id == sessions_t.c.connector_id)
            .where(
                sessions_t.c.id.in_(ordered),
                connectors_t.c.revoked == 0,
            )
        )
        if user_id is not None:
            owned_query = owned_query.where(connectors_t.c.user_id == user_id)

        async with closing_connection(self._engine, write=True) as conn:
            rows = (await conn.execute(owned_query)).all()
            owned_ids = {str(row.id) for row in rows}
            if owned_ids:
                await conn.execute(
                    update(sessions_t)
                    .where(sessions_t.c.id.in_(owned_ids))
                    .values(**_manual_archive_values(archived=archived, now=now))
                )

        sessions: list[SessionView] = []
        if owned_ids:
            view_query = (
                _session_view_query()
                .where(sessions_t.c.id.in_(owned_ids))
            )
            async with read_connection(self._engine) as conn:
                view_rows = (await conn.execute(view_query)).mappings().all()
            by_id = {
                session.id: session
                for session in await self._sessions_from_rows(view_rows)
            }
            sessions = [by_id[sid] for sid in ordered if sid in by_id]
        not_found = [sid for sid in ordered if sid not in owned_ids]
        return sessions, not_found


    async def archive_device_sessions(
        self,
        connector_id: str,
        archived: bool,
        *,
        scope: str = "active",
        user_id: str | None = None,
    ) -> list[SessionView]:
        # Verify connector ownership; raises KeyError if not owned.
        await self.get_connector(connector_id)
        if user_id is not None:
            conn_query = select(connectors_t.c.id).where(
                connectors_t.c.id == connector_id,
                connectors_t.c.user_id == user_id,
                connectors_t.c.revoked == 0,
            )
            async with read_connection(self._engine) as conn:
                owned = (await conn.execute(conn_query)).first()
            if owned is None:
                raise KeyError(connector_id)

        scope_filter = None
        if scope == "active":
            scope_filter = sessions_t.c.archived == 0
        elif scope == "archived":
            scope_filter = sessions_t.c.archived == 1
        elif scope == "all":
            scope_filter = None
        else:
            raise ValueError(f"invalid scope: {scope}")

        now = utc_now()
        target_query = select(sessions_t.c.id).where(
            sessions_t.c.connector_id == connector_id,
        )
        if scope_filter is not None:
            target_query = target_query.where(scope_filter)

        async with closing_connection(self._engine, write=True) as conn:
            target_rows = (await conn.execute(target_query)).all()
            target_ids = [str(row.id) for row in target_rows]
            if target_ids:
                await conn.execute(
                    update(sessions_t)
                    .where(sessions_t.c.id.in_(target_ids))
                    .values(**_manual_archive_values(archived=archived, now=now))
                )

        if not target_ids:
            return []

        view_query = (
            _session_view_query()
            .where(sessions_t.c.id.in_(target_ids))
        )
        async with read_connection(self._engine) as conn:
            view_rows = (await conn.execute(view_query)).mappings().all()
        return await self._sessions_from_rows(view_rows)


    async def rename_session(
        self,
        session_id: str,
        title: str,
        *,
        user_id: str | None = None,
    ) -> SessionView:
        cleaned = title.strip()
        if not cleaned:
            raise ValueError("title must not be empty")
        await self.get_session(session_id, user_id=user_id)
        now = utc_now()
        async with closing_connection(self._engine, write=True) as conn:
            await conn.execute(
                update(sessions_t)
                .where(sessions_t.c.id == session_id)
                .values(title=cleaned, title_source=TITLE_SOURCE_USER, updated_at=now)
            )
        return await self.get_session(session_id, user_id=user_id)


    async def mark_session_read(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> SessionView:
        await self.get_session(session_id, user_id=user_id)
        now = utc_now()
        async with closing_connection(self._engine, write=True) as conn:
            row = (
                await conn.execute(
                    select(sessions_t.c.updated_seq).where(sessions_t.c.id == session_id)
                )
            ).first()
            current = int(row.updated_seq) if row else 0
            await conn.execute(
                update(sessions_t)
                .where(sessions_t.c.id == session_id)
                .values(last_read_seq=current, updated_at=now)
            )
        return await self.get_session(session_id, user_id=user_id)


    async def bulk_mark_sessions_read(
        self,
        session_ids: list[str],
        *,
        user_id: str | None = None,
    ) -> tuple[list[SessionView], list[str]]:
        seen: set[str] = set()
        ordered: list[str] = []
        for sid in session_ids:
            if sid not in seen:
                seen.add(sid)
                ordered.append(sid)
        if not ordered:
            return [], []

        owned_query = (
            select(sessions_t.c.id)
            .join(connectors_t, connectors_t.c.id == sessions_t.c.connector_id)
            .where(
                sessions_t.c.id.in_(ordered),
                connectors_t.c.revoked == 0,
            )
        )
        if user_id is not None:
            owned_query = owned_query.where(connectors_t.c.user_id == user_id)

        now = utc_now()
        async with closing_connection(self._engine, write=True) as conn:
            rows = (await conn.execute(owned_query)).all()
            owned_ids = {str(row.id) for row in rows}
            if owned_ids:
                await conn.execute(
                    update(sessions_t)
                    .where(sessions_t.c.id.in_(owned_ids))
                    .values(last_read_seq=sessions_t.c.updated_seq, updated_at=now)
                )

        sessions: list[SessionView] = []
        if owned_ids:
            view_query = (
                _session_view_query()
                .where(sessions_t.c.id.in_(owned_ids))
            )
            async with read_connection(self._engine) as conn:
                view_rows = (await conn.execute(view_query)).mappings().all()
            by_id = {session.id: session for session in await self._sessions_from_rows(view_rows)}
            sessions = [by_id[sid] for sid in ordered if sid in by_id]

        not_found = [sid for sid in ordered if sid not in owned_ids]
        return sessions, not_found

    async def list_owned_session_ids(
        self,
        session_ids: list[str],
        *,
        user_id: str | None = None,
    ) -> list[str]:
        """Return requested session IDs visible to one user in input order."""

        ordered = list(dict.fromkeys(session_ids))
        if not ordered:
            return []
        statement = (
            select(sessions_t.c.id)
            .join(connectors_t, connectors_t.c.id == sessions_t.c.connector_id)
            .where(
                sessions_t.c.id.in_(ordered),
                connectors_t.c.revoked == 0,
            )
        )
        if user_id is not None:
            statement = statement.where(connectors_t.c.user_id == user_id)
        async with read_connection(self._engine) as conn:
            rows = (await conn.execute(statement)).all()
        owned_ids = {str(row.id) for row in rows}
        return [session_id for session_id in ordered if session_id in owned_ids]


    async def set_session_status(
        self,
        session_id: str,
        status: str,
        *,
        expected_status: str | None = None,
        mark_read_on_change: bool = False,
    ) -> SessionView:
        async with self.session_revision_fence(session_id):
            changed = False
            async with closing_connection(self._engine, write=True) as conn:
                statement = select(sessions_t.c.status).where(
                    sessions_t.c.id == session_id
                )
                if expected_status is not None:
                    statement = statement.with_for_update()
                row = (await conn.execute(statement)).first()
                if row is None:
                    raise KeyError(session_id)
                if expected_status is not None and row.status != expected_status:
                    raise ValueError("session status changed")
                if row.status != status:
                    await self._bump_session(
                        conn,
                        session_id,
                        mark_read=mark_read_on_change,
                    )
                    update_statement = update(sessions_t).where(
                        sessions_t.c.id == session_id
                    )
                    if expected_status is not None:
                        update_statement = update_statement.where(
                            sessions_t.c.status == expected_status
                        )
                    result = await conn.execute(update_statement.values(status=status))
                    if result.rowcount != 1:
                        raise ValueError("session status changed")
                    changed = True
            session = await self.get_session(session_id)
            if changed:
                await self.publish_session_revision_result(
                    session_id,
                    operation="set_session_status",
                    result=session,
                )
            return session


    @session_revision_fenced
    async def update_session_snapshot(
        self,
        *,
        session_id: str,
        status: str | None = None,
        title: str | None = None,
        cwd: str | None = None,
        external_session_id: str | None = None,
        last_synced_at: str | None = None,
        source_observed_at: str | None = None,
        last_activity_at: str | None = None,
        mark_read_on_change: bool = False,
        source_state: str | None = None,
    ) -> SessionView:
        values: dict[str, Any] = {}
        if status is not None:
            values["status"] = status
        if external_session_id is not None:
            values["external_session_id"] = external_session_id
        if last_synced_at is not None:
            values["last_synced_at"] = last_synced_at
        if source_observed_at is not None:
            values["source_observed_at"] = source_observed_at
        if last_activity_at is not None:
            values["last_activity_at"] = last_activity_at
        if source_state is not None:
            values["source_state"] = source_state
            values["source_state_at"] = utc_now()
            values["source_changed_seq"] = _next_source_change_seq()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(
                        sessions_t.c.connector_id,
                        sessions_t.c.project_id,
                        sessions_t.c.status,
                        sessions_t.c.title,
                        sessions_t.c.title_source,
                        sessions_t.c.cwd,
                        sessions_t.c.external_session_id,
                        sessions_t.c.last_activity_at,
                        sessions_t.c.source_state,
                        sessions_t.c.runtime,
                        sessions_t.c.archived,
                        sessions_t.c.dsh_archive_legacy,
                    ).where(sessions_t.c.id == session_id)
                )
            ).first()
            if row is None:
                raise KeyError(session_id)
            if (
                title is not None
                and row.title_source != TITLE_SOURCE_USER
                and row.title != title
            ):
                values["title"] = title
                values["title_source"] = TITLE_SOURCE_CONNECTOR
            if cwd is not None or row.project_id is None:
                project_id, normalized_cwd = await self._ensure_project_for_workspace(
                    conn,
                    connector_id=row.connector_id,
                    workspace_path=cwd if cwd is not None else row.cwd,
                )
                values["project_id"] = project_id
                values["cwd"] = normalized_cwd
            if source_state is not None:
                values.update(
                    _source_archive_update(
                        row.source_state,
                        source_state,
                        archived=row.archived,
                        observed_at=values["source_state_at"],
                    )
                )
            semantic_fields = {
                "status",
                "title",
                "cwd",
                "project_id",
                "external_session_id",
                "source_state",
                "archived",
                "dsh_archive_legacy",
            }
            if any(field in values and values[field] != getattr(row, field) for field in semantic_fields):
                await self._bump_session(
                    conn,
                    session_id,
                    mark_read=mark_read_on_change,
                )
            if values:
                await conn.execute(
                    update(sessions_t).where(sessions_t.c.id == session_id).values(**values)
                )
        return await self.get_session(session_id)


    async def _derive_title_from_first_user_message(self, session_id: str) -> str | None:
        query = (
            select(timeline_items_t.c.payload_json)
            .where(
                timeline_items_t.c.session_id == session_id,
                timeline_items_t.c.type == "message",
                timeline_items_t.c.role == "user",
            )
            .order_by(timeline_items_t.c.order_seq.asc(), timeline_items_t.c.updated_seq.asc())
            .limit(1)
        )
        async with read_connection(self._engine) as conn:
            row = (await conn.execute(query)).first()
        if row is None:
            return None
        payload = _json_loads(row[0])
        if not isinstance(payload, dict):
            return None
        text = _message_text(payload.get("content"))
        return _truncate_title(text) if text else None


    async def _lock_in_derived_title(self, session_id: str, title: str) -> None:
        # Guard against races: only fill when DB title is still empty.
        async with closing_connection(self._engine, write=True) as conn:
            await conn.execute(
                sessions_t.update()
                .where(
                    sessions_t.c.id == session_id,
                    sessions_t.c.title.is_(None) | (sessions_t.c.title == ""),
                )
                .values(title=title)
            )


    async def _derive_titles_from_first_user_messages(
        self, session_ids: list[str]
    ) -> dict[str, str]:
        """Derive and lock in titles for many untitled sessions in two round trips.

        A list read used to issue one query per untitled session, so sessions
        that never received a user message re-ran that query on every read.
        """

        first_user_message = (
            select(timeline_items_t.c.payload_json)
            .where(
                timeline_items_t.c.session_id == sessions_t.c.id,
                timeline_items_t.c.type == "message",
                timeline_items_t.c.role == "user",
            )
            .order_by(timeline_items_t.c.order_seq.asc(), timeline_items_t.c.updated_seq.asc())
            .limit(1)
            .scalar_subquery()
        )
        query = select(sessions_t.c.id, first_user_message.label("payload_json")).where(
            sessions_t.c.id.in_(session_ids)
        )
        async with read_connection(self._engine) as conn:
            rows = (await conn.execute(query)).all()
        derived: dict[str, str] = {}
        for session_id, payload_json in rows:
            if payload_json is None:
                continue
            payload = _json_loads(payload_json)
            if not isinstance(payload, dict):
                continue
            text = _message_text(payload.get("content"))
            title = _truncate_title(text) if text else None
            if title:
                derived[str(session_id)] = title
        if derived:
            async with self._engine.begin() as conn:
                for session_id, title in derived.items():
                    await conn.execute(
                        sessions_t.update()
                        .where(
                            sessions_t.c.id == session_id,
                            sessions_t.c.title.is_(None) | (sessions_t.c.title == ""),
                        )
                        .values(title=title)
                    )
        return derived

    async def _sessions_from_rows(self, rows: Sequence[Any]) -> list[SessionView]:
        untitled = [str(row["id"]) for row in rows if not _has_title(row["title"])]
        derived = (
            await self._derive_titles_from_first_user_messages(untitled)
            if untitled
            else {}
        )
        return [
            await self._session_from_row(row, derived_titles=derived)
            for row in rows
        ]

    async def _session_from_row(
        self,
        row: Any,
        *,
        derived_titles: dict[str, str] | None = None,
    ) -> SessionView:
        session_id = row["id"]
        runtime = row["runtime"]
        runtime_id = row["runtime_id"]
        title = row["title"]
        if not _has_title(title):
            if derived_titles is not None:
                title = derived_titles.get(str(session_id), title)
            else:
                derived = await self._derive_title_from_first_user_message(session_id)
                if derived:
                    title = derived
                    await self._lock_in_derived_title(session_id, derived)
        has_latest = row.get("latest_item_order_seq") is not None
        last_item_at = row.get("latest_item_at") if has_latest else None
        sort_at = row.get("session_sort_at") or last_item_at or row["last_activity_at"] or row["created_at"]
        last_read_seq = int(row["last_read_seq"] or 0)
        latest_turn_end_seq = int(row["latest_turn_end_seq"] or 0)
        updated_seq = int(row["updated_seq"] or 0)
        aa_archived = bool(row["archived"])
        source_availability = _normalized_source_availability(row["source_state"])
        return SessionView(
            id=session_id,
            connectorId=row["connector_id"],
            projectId=row["project_id"],
            connectorStatus=row["connector_status"],
            runtime=runtime,
            runtimeId=runtime_id,
            runtimeName=row.get("runtime_name"),
            runtimeTypeDisplayName=row.get("runtime_type_display_name"),
            externalSessionId=row["external_session_id"],
            title=title,
            cwd=row["cwd"],
            status=row["status"],
            takeover=bool(row["takeover"]),
            pinned=bool(row["pinned"]),
            pinnedAt=row["pinned_at"],
            archived=aa_archived,
            archivedAt=row["archived_at"],
            userArchived=aa_archived,
            sourceAvailability=source_availability,
            sourceAvailabilityReason=row["source_state_reason"],
            sourceAvailabilityUpdatedAt=row["source_state_at"],
            sourceObservationOrigin=row["source_observation_origin"],
            archiveSource="user" if aa_archived else None,
            unread=latest_turn_end_seq > last_read_seq,
            lastReadSeq=last_read_seq,
            latestTurnEndSeq=latest_turn_end_seq,
            lastSyncedAt=row["last_synced_at"],
            sourceObservedAt=row["source_observed_at"],
            lastActivityAt=row["last_activity_at"],
            lastItemAt=last_item_at,
            lastItemOrderSeq=int(row["latest_item_order_seq"]) if has_latest else None,
            sortAt=sort_at,
            updatedSeq=updated_seq,
        )
