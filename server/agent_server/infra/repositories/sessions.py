# ruff: noqa: F403, F405, I001

from __future__ import annotations

from agent_server.infra.repositories.store_support import *
from agent_server.core.models import TimelineItem


SESSION_CURSOR_VERSION = 1


def _latest_timeline_item_subquery() -> Any:
    ranked = select(
        timeline_items_t.c.session_id,
        timeline_items_t.c.item_time,
        timeline_items_t.c.order_seq,
        timeline_items_t.c.updated_seq,
        timeline_items_t.c.payload_json,
        func.row_number()
        .over(
            partition_by=timeline_items_t.c.session_id,
            order_by=(
                func.coalesce(timeline_items_t.c.item_time, "").desc(),
                timeline_items_t.c.order_seq.desc(),
                timeline_items_t.c.updated_seq.desc(),
            ),
        )
        .label("rank"),
    ).subquery("ranked_session_timeline_items")
    return (
        select(
            ranked.c.session_id,
            ranked.c.item_time.label("latest_item_time"),
            ranked.c.order_seq.label("latest_item_order_seq"),
            ranked.c.updated_seq.label("latest_item_updated_seq"),
            ranked.c.payload_json.label("latest_item_payload_json"),
        )
        .where(ranked.c.rank == 1)
        .subquery("latest_session_timeline_item")
    )


def _session_cursor_values(row: Any) -> tuple[int, str, int, int, str]:
    return (
        int(row["pinned"] or 0),
        str(row["session_sort_at"] or ""),
        int(row["latest_item_order_seq"] or -1),
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


def _session_sort_at(latest_item: Any) -> Any:
    return func.coalesce(
        sessions_t.c.sort_at,
        sessions_t.c.last_activity_at,
        latest_item.c.latest_item_time,
        sessions_t.c.created_at,
    )


def _session_view_query(latest_item: Any | None = None) -> Any:
    if latest_item is None:
        latest_item = _latest_timeline_item_subquery()
    session_sort_at = _session_sort_at(latest_item).label("session_sort_at")
    return select(
        sessions_t,
        connectors_t.c.status.label("connector_status"),
        device_runtimes_t.c.name.label("runtime_name"),
        connector_runtime_types_t.c.display_name.label("runtime_type_display_name"),
        latest_item.c.latest_item_time,
        latest_item.c.latest_item_order_seq,
        latest_item.c.latest_item_updated_seq,
        latest_item.c.latest_item_payload_json,
        session_sort_at,
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
        .outerjoin(
            latest_item,
            latest_item.c.session_id == sessions_t.c.id,
        )
    )


class SessionRepositoryMixin:
    async def get_session_runtime(self, session_id: str) -> str | None:
        async with self._engine.connect() as conn:
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
    ) -> SessionView:
        identity = _runtime_identity(runtime, runtime_id)
        session_id = f"sess_{secrets.token_urlsafe(10)}"
        now = utc_now()
        async with self._engine.begin() as conn:
            connector_q = select(connectors_t.c.status).where(
                connectors_t.c.id == connector_id, connectors_t.c.revoked == 0
            )
            if user_id is not None:
                connector_q = connector_q.where(connectors_t.c.user_id == user_id)
            connector = (await conn.execute(connector_q)).first()
            if connector is None:
                raise KeyError(connector_id)
            await conn.execute(
                insert(sessions_t).values(
                    id=session_id,
                    connector_id=connector_id,
                    runtime=str(identity.runtime_type),
                    runtime_id=str(identity.runtime_id),
                    origin="platform",
                    model_selection_id=model_selection_id,
                    permission_selection_id=permission_selection_id,
                    external_session_id=external_session_id,
                    title=title,
                    cwd=cwd,
                    status="idle",
                    takeover=int(takeover),
                    sort_at=now,
                    seq=0,
                    updated_seq=0,
                    created_at=now,
                    updated_at=now,
                )
            )
        return await self.get_session(session_id)

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
        runtime = str(identity.runtime_type)
        runtime_id = str(identity.runtime_id)
        has_model_selection_id = model_selection_id is not None
        has_permission_selection_id = permission_selection_id is not None
        now = utc_now()
        normalized_origin = _normalize_session_origin(origin)
        async with self._engine.begin() as conn:
            connector = (
                await conn.execute(
                    select(connectors_t.c.status).where(connectors_t.c.id == connector_id)
                )
            ).first()
            if connector is None:
                raise KeyError(connector_id)
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
                            sessions_t.c.runtime_id == runtime_id,
                            sessions_t.c.external_session_id == external_session_id,
                        )
                        .order_by(sessions_t.c.takeover.desc(), sessions_t.c.created_at.asc())
                        .limit(1)
                    )
                ).first()
                if existing is not None:
                    session_id = existing.id
            if existing is None:
                await conn.execute(
                    insert(sessions_t).values(
                        id=session_id,
                        connector_id=connector_id,
                        runtime=runtime,
                        runtime_id=runtime_id,
                        origin=normalized_origin,
                        model_selection_id=model_selection_id,
                        permission_selection_id=permission_selection_id,
                        external_session_id=external_session_id,
                        title=title,
                        cwd=cwd,
                        status=status or "idle",
                        takeover=0,
                        last_synced_at=last_synced_at,
                        source_observed_at=source_observed_at,
                        last_activity_at=last_activity_at,
                        sort_at=last_activity_at or now,
                        source_state=source_state or "visible",
                        source_state_at=now if source_state is not None else None,
                        seq=1,
                        updated_seq=1,
                        created_at=now,
                        updated_at=now,
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
                            sessions_t.c.cwd,
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
                if title is not None:
                    values["title"] = title
                if cwd is not None:
                    values["cwd"] = cwd
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
                    values["source_scan_token"] = None
                if (
                    runtime == "dsh"
                    and source_state == "visible"
                    and current.archived == 1
                    and current.dsh_archive_legacy == 1
                ):
                    values["archived"] = 0
                    values["archived_at"] = None
                    values["dsh_archive_legacy"] = 0
                semantic_changed = any(
                    field in values and values[field] != getattr(current, field)
                    for field in (
                        "external_session_id",
                        "title",
                        "cwd",
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
        async with self._engine.connect() as conn:
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


    async def list_sessions_page(
        self,
        *,
        archived: bool,
        limit: int = 100,
        cursor: str | None = None,
        user_id: str | None = None,
    ) -> tuple[list[SessionView], bool, str | None]:
        latest_item = _latest_timeline_item_subquery()
        sort_at = _session_sort_at(latest_item)
        query = (
            _session_view_query(latest_item)
            .where(
                connectors_t.c.revoked == 0,
                sessions_t.c.archived == int(archived),
                (sessions_t.c.runtime != "dsh")
                | (sessions_t.c.source_state == "visible"),
            )
            .order_by(
                sessions_t.c.pinned.desc(),
                sort_at.desc(),
                sessions_t.c.id.desc(),
            )
            .limit(limit + 1)
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        if cursor:
            pinned, cursor_sort_at, _order_seq, _updated_seq, session_id = (
                _decode_session_cursor(cursor)
            )
            query = query.where(
                or_(
                    sessions_t.c.pinned < pinned,
                    and_(sessions_t.c.pinned == pinned, sort_at < cursor_sort_at),
                    and_(
                        sessions_t.c.pinned == pinned,
                        sort_at == cursor_sort_at,
                        sessions_t.c.id < session_id,
                    ),
                )
            )
        async with self._engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
        page_rows = rows[:limit]
        sessions = [await self._session_from_row(row) for row in page_rows]
        has_more = len(rows) > limit
        next_cursor = _encode_session_cursor(page_rows[-1]) if has_more and page_rows else None
        return sessions, has_more, next_cursor

    async def touch_session_sort_at(
        self,
        session_id: str,
        *,
        sort_at: str | None = None,
    ) -> None:
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(sessions_t)
                .where(sessions_t.c.id == session_id)
                .values(sort_at=sort_at or utc_now())
            )
        if result.rowcount == 0:
            raise KeyError(session_id)

    async def list_sessions(
        self,
        *,
        archived: bool = False,
        limit: int = 100,
        cursor: str | None = None,
        user_id: str | None = None,
    ) -> list[SessionView]:
        sessions, _, _ = await self.list_sessions_page(
            archived=archived,
            limit=limit,
            cursor=cursor,
            user_id=user_id,
        )
        return sessions

    async def begin_dsh_session_inventory(
        self,
        connector_id: str,
        runtime_id: str,
        scan_token: str,
    ) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                update(sessions_t)
                .where(
                    sessions_t.c.connector_id == connector_id,
                    sessions_t.c.runtime == "dsh",
                    sessions_t.c.runtime_id == runtime_id,
                )
                .values(source_scan_token=scan_token)
            )

    async def complete_dsh_session_inventory(
        self,
        connector_id: str,
        runtime_id: str,
        scan_token: str,
        entries: list[dict[str, str | None]],
        *,
        complete: bool,
    ) -> list[str]:
        now = utc_now()
        changed: list[str] = []
        async with self._engine.begin() as conn:
            rows = (
                await conn.execute(
                    select(
                        sessions_t.c.id,
                        sessions_t.c.external_session_id,
                        sessions_t.c.source_state,
                        sessions_t.c.source_scan_token,
                        sessions_t.c.archived,
                        sessions_t.c.dsh_archive_legacy,
                    ).where(
                        sessions_t.c.connector_id == connector_id,
                        sessions_t.c.runtime == "dsh",
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
            for entry in entries:
                row = by_id.get(str(entry["session_id"]))
                external_session_id = entry.get("external_session_id")
                if row is None and external_session_id is not None:
                    row = by_external_id.get(external_session_id)
                if row is None or row["source_scan_token"] != scan_token:
                    continue
                session_id = str(row["id"])
                observed_ids.add(session_id)
                source_state = str(entry["source_state"])
                recover_legacy_archive = (
                    source_state == "visible"
                    and row["archived"] == 1
                    and row["dsh_archive_legacy"] == 1
                )
                values: dict[str, Any] = {
                    "source_state": source_state,
                    "source_state_at": now,
                    "source_scan_token": None,
                }
                if recover_legacy_archive:
                    values.update(
                        archived=0,
                        archived_at=None,
                        dsh_archive_legacy=0,
                    )
                result = await conn.execute(
                    update(sessions_t)
                    .where(
                        sessions_t.c.id == session_id,
                        sessions_t.c.source_scan_token == scan_token,
                    )
                    .values(**values)
                )
                if result.rowcount == 0:
                    continue
                if row["source_state"] != source_state or recover_legacy_archive:
                    await self._bump_session(conn, session_id)
                    changed.append(session_id)

            remaining_rows = [
                row
                for row in rows
                if row["source_scan_token"] == scan_token
                and str(row["id"]) not in observed_ids
            ]
            if complete:
                for row in remaining_rows:
                    session_id = str(row["id"])
                    result = await conn.execute(
                        update(sessions_t)
                        .where(
                            sessions_t.c.id == session_id,
                            sessions_t.c.source_scan_token == scan_token,
                        )
                        .values(
                            source_state="missing",
                            source_state_at=now,
                            source_scan_token=None,
                        )
                    )
                    if result.rowcount == 0:
                        continue
                    if row["source_state"] != "missing":
                        await self._bump_session(conn, session_id)
                        changed.append(session_id)
            elif remaining_rows:
                await conn.execute(
                    update(sessions_t)
                    .where(
                        sessions_t.c.id.in_([str(row["id"]) for row in remaining_rows]),
                        sessions_t.c.source_scan_token == scan_token,
                    )
                    .values(source_scan_token=None)
                )
        return changed


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
        async with self._engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
        return [await self._session_from_row(row) for row in rows]

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
        async with self._engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
        return [await self._session_from_row(row) for row in rows]


    async def get_session(self, session_id: str, *, user_id: str | None = None) -> SessionView:
        query = (
            _session_view_query()
            .where(sessions_t.c.id == session_id, connectors_t.c.revoked == 0)
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.connect() as conn:
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
        async with self._engine.connect() as conn:
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
        async with self._engine.connect() as conn:
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
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(sessions_t.c.seq).where(sessions_t.c.id == session_id)
                )
            ).first()
        if row is None:
            raise KeyError(session_id)
        return int(row.seq)


    async def set_takeover(self, session_id: str, takeover: bool) -> SessionView:
        async with self._engine.begin() as conn:
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
        async with self._engine.begin() as conn:
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
        async with self._engine.begin() as conn:
            await conn.execute(
                update(sessions_t)
                .where(sessions_t.c.id == session_id)
                .values(
                    archived=int(bool(archived)),
                    archived_at=now if archived else None,
                    dsh_archive_legacy=0,
                    updated_at=now,
                )
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

        async with self._engine.begin() as conn:
            rows = (await conn.execute(owned_query)).all()
            owned_ids = {str(row.id) for row in rows}
            if owned_ids:
                await conn.execute(
                    update(sessions_t)
                    .where(sessions_t.c.id.in_(owned_ids))
                    .values(
                        archived=int(bool(archived)),
                        archived_at=now if archived else None,
                        dsh_archive_legacy=0,
                        updated_at=now,
                    )
                )

        sessions: list[SessionView] = []
        if owned_ids:
            view_query = (
                _session_view_query()
                .where(sessions_t.c.id.in_(owned_ids))
            )
            async with self._engine.connect() as conn:
                view_rows = (await conn.execute(view_query)).mappings().all()
            by_id = {row["id"]: row for row in view_rows}
            for sid in ordered:
                row = by_id.get(sid)
                if row is not None:
                    sessions.append(await self._session_from_row(row))
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
            async with self._engine.connect() as conn:
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

        async with self._engine.begin() as conn:
            target_rows = (await conn.execute(target_query)).all()
            target_ids = [str(row.id) for row in target_rows]
            if target_ids:
                await conn.execute(
                    update(sessions_t)
                    .where(sessions_t.c.id.in_(target_ids))
                    .values(
                        archived=int(bool(archived)),
                        archived_at=now if archived else None,
                        dsh_archive_legacy=0,
                        updated_at=now,
                    )
                )

        if not target_ids:
            return []

        view_query = (
            _session_view_query()
            .where(sessions_t.c.id.in_(target_ids))
        )
        async with self._engine.connect() as conn:
            view_rows = (await conn.execute(view_query)).mappings().all()
        return [await self._session_from_row(row) for row in view_rows]


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
        async with self._engine.begin() as conn:
            await conn.execute(
                update(sessions_t)
                .where(sessions_t.c.id == session_id)
                .values(title=cleaned, updated_at=now)
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
        async with self._engine.begin() as conn:
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
        async with self._engine.begin() as conn:
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
            async with self._engine.connect() as conn:
                view_rows = (await conn.execute(view_query)).mappings().all()
            by_id = {str(row["id"]): await self._session_from_row(row) for row in view_rows}
            sessions = [by_id[sid] for sid in ordered if sid in by_id]

        not_found = [sid for sid in ordered if sid not in owned_ids]
        return sessions, not_found


    async def set_session_status(
        self,
        session_id: str,
        status: str,
        *,
        expected_status: str | None = None,
        mark_read_on_change: bool = False,
    ) -> SessionView:
        async with self._engine.begin() as conn:
            statement = select(sessions_t.c.status).where(sessions_t.c.id == session_id)
            if expected_status is not None:
                statement = statement.with_for_update()
            row = (
                await conn.execute(statement)
            ).first()
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
        return await self.get_session(session_id)


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
        if title is not None:
            values["title"] = title
        if cwd is not None:
            values["cwd"] = cwd
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
            values["source_scan_token"] = None
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(
                        sessions_t.c.status,
                        sessions_t.c.title,
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
                row.runtime == "dsh"
                and source_state == "visible"
                and row.archived == 1
                and row.dsh_archive_legacy == 1
            ):
                values["archived"] = 0
                values["archived_at"] = None
                values["dsh_archive_legacy"] = 0
            semantic_fields = {
                "status",
                "title",
                "cwd",
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
        async with self._engine.connect() as conn:
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
        async with self._engine.begin() as conn:
            await conn.execute(
                sessions_t.update()
                .where(
                    sessions_t.c.id == session_id,
                    sessions_t.c.title.is_(None) | (sessions_t.c.title == ""),
                )
                .values(title=title)
            )


    async def _session_from_row(self, row: Any) -> SessionView:
        session_id = row["id"]
        latest_payload = row.get("latest_item_payload_json")
        latest = (
            TimelineItem.model_validate_json(latest_payload)
            if latest_payload
            else None
        )
        runtime = row["runtime"]
        runtime_id = row["runtime_id"]
        title = row["title"]
        if not (isinstance(title, str) and title.strip()):
            derived = await self._derive_title_from_first_user_message(session_id)
            if derived:
                title = derived
                await self._lock_in_derived_title(session_id, derived)
        last_item_at = (latest.updatedAt or latest.completedAt or latest.createdAt) if latest else None
        sort_at = row.get("session_sort_at") or last_item_at or row["last_activity_at"] or row["created_at"]
        last_read_seq = int(row["last_read_seq"] or 0)
        latest_turn_end_seq = int(row["latest_turn_end_seq"] or 0)
        updated_seq = int(row["updated_seq"] or 0)
        return SessionView(
            id=session_id,
            connectorId=row["connector_id"],
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
            archived=bool(row["archived"]),
            archivedAt=row["archived_at"],
            unread=latest_turn_end_seq > last_read_seq,
            lastReadSeq=last_read_seq,
            latestTurnEndSeq=latest_turn_end_seq,
            lastSyncedAt=row["last_synced_at"],
            sourceObservedAt=row["source_observed_at"],
            lastActivityAt=row["last_activity_at"],
            lastItemAt=last_item_at,
            lastItemOrderSeq=latest.orderSeq if latest else None,
            sortAt=sort_at,
            updatedSeq=updated_seq,
        )
