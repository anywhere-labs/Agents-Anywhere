from __future__ import annotations

from agent_server.infra.repositories.store_support import *


class SessionRepositoryMixin:
    async def create_session(
        self,
        *,
        connector_id: str,
        user_id: str | None = None,
        runtime: str,
        external_session_id: str | None,
        title: str | None,
        cwd: str | None,
        runtime_settings_override: dict[str, Any] | None = None,
    ) -> SessionView:
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
            if runtime_settings_override is None and runtime in {"codex", "claude"}:
                runtime_settings_override = await self.get_initial_runtime_settings_for_connector_agent(
                    connector_id,
                    runtime,
                    user_id=user_id,
                )
            await conn.execute(
                insert(sessions_t).values(
                    id=session_id,
                    connector_id=connector_id,
                    runtime=runtime,
                    runtime_settings_override=(
                        _json_dumps(runtime_settings_override)
                        if runtime_settings_override is not None
                        else None
                    ),
                    external_session_id=external_session_id,
                    title=title,
                    cwd=cwd,
                    status="idle",
                    takeover=0,
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
        external_session_id: str | None,
        title: str | None = None,
        cwd: str | None = None,
        status: str | None = None,
        last_synced_at: str | None = None,
        source_observed_at: str | None = None,
        last_activity_at: str | None = None,
        runtime_settings_override: dict[str, Any] | None = None,
    ) -> SessionView:
        has_runtime_settings_override = runtime_settings_override is not None
        now = utc_now()
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
                            sessions_t.c.external_session_id == external_session_id,
                        )
                        .order_by(sessions_t.c.takeover.desc(), sessions_t.c.created_at.asc())
                        .limit(1)
                    )
                ).first()
                if existing is not None:
                    session_id = existing.id
            if existing is None:
                if runtime_settings_override is None and runtime in {"codex", "claude"}:
                    runtime_settings_override = await self.get_initial_runtime_settings_for_connector_agent(
                        connector_id,
                        runtime,
                    )
                await conn.execute(
                    insert(sessions_t).values(
                        id=session_id,
                        connector_id=connector_id,
                        runtime=runtime,
                        runtime_settings_override=(
                            _json_dumps(runtime_settings_override)
                            if runtime_settings_override is not None
                            else None
                        ),
                        external_session_id=external_session_id,
                        title=title,
                        cwd=cwd,
                        status=status or "idle",
                        takeover=0,
                        last_synced_at=last_synced_at,
                        source_observed_at=source_observed_at,
                        last_activity_at=last_activity_at,
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
                            sessions_t.c.external_session_id,
                            sessions_t.c.title,
                            sessions_t.c.cwd,
                            sessions_t.c.status,
                        ).where(sessions_t.c.id == session_id)
                    )
                ).first()
                if current is None:
                    raise KeyError(session_id)
                values: dict[str, Any] = {
                    "connector_id": connector_id,
                    "runtime": runtime,
                }
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
                if has_runtime_settings_override:
                    values["runtime_settings_override"] = (
                        _json_dumps(runtime_settings_override)
                        if runtime_settings_override is not None
                        else None
                    )
                semantic_changed = any(
                    field in values and values[field] != getattr(current, field)
                    for field in (
                        "connector_id",
                        "runtime",
                        "external_session_id",
                        "title",
                        "cwd",
                        "status",
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
    ) -> str:
        async with self._engine.connect() as conn:
            if external_session_id:
                row = (
                    await conn.execute(
                        select(sessions_t.c.id)
                        .where(
                            sessions_t.c.connector_id == connector_id,
                            sessions_t.c.external_session_id == external_session_id,
                        )
                        .order_by(sessions_t.c.takeover.desc(), sessions_t.c.created_at.asc())
                        .limit(1)
                    )
                ).first()
                if row is not None:
                    return str(row.id)
            row = (
                await conn.execute(
                    select(sessions_t.c.id).where(
                        sessions_t.c.id == session_id,
                        sessions_t.c.connector_id == connector_id,
                    )
                )
            ).first()
        if row is None:
            raise KeyError(session_id)
        return str(row.id)


    async def list_sessions(self, *, user_id: str | None = None) -> list[SessionView]:
        query = (
            select(sessions_t, connectors_t.c.status.label("connector_status"))
            .join(connectors_t, connectors_t.c.id == sessions_t.c.connector_id)
            .where(connectors_t.c.revoked == 0)
            .order_by(sessions_t.c.created_at.desc())
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
        sessions = [await self._session_from_row(row) for row in rows]
        return sorted(
            sessions,
            key=lambda session: (session.sortAt or "", session.lastItemOrderSeq or -1, session.updatedSeq),
            reverse=True,
        )


    async def list_running_sessions_for_connector_agent(
        self,
        *,
        connector_id: str,
        runtime: str,
        user_id: str | None = None,
    ) -> list[SessionView]:
        query = (
            select(sessions_t, connectors_t.c.status.label("connector_status"))
            .join(connectors_t, connectors_t.c.id == sessions_t.c.connector_id)
            .where(
                sessions_t.c.connector_id == connector_id,
                sessions_t.c.runtime == runtime,
                sessions_t.c.status.in_(("running", "waiting_approval")),
                connectors_t.c.revoked == 0,
            )
            .order_by(sessions_t.c.updated_at.asc())
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.connect() as conn:
            rows = (await conn.execute(query)).mappings().all()
        return [await self._session_from_row(row) for row in rows]


    async def get_session(self, session_id: str, *, user_id: str | None = None) -> SessionView:
        query = (
            select(sessions_t, connectors_t.c.status.label("connector_status"))
            .join(connectors_t, connectors_t.c.id == sessions_t.c.connector_id)
            .where(sessions_t.c.id == session_id, connectors_t.c.revoked == 0)
        )
        if user_id is not None:
            query = query.where(connectors_t.c.user_id == user_id)
        async with self._engine.connect() as conn:
            row = (await conn.execute(query)).mappings().first()
        if row is None:
            raise KeyError(session_id)
        return await self._session_from_row(row)


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
                        updated_at=now,
                    )
                )

        sessions: list[SessionView] = []
        if owned_ids:
            view_query = (
                select(sessions_t, connectors_t.c.status.label("connector_status"))
                .join(connectors_t, connectors_t.c.id == sessions_t.c.connector_id)
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
                        updated_at=now,
                    )
                )

        if not target_ids:
            return []

        view_query = (
            select(sessions_t, connectors_t.c.status.label("connector_status"))
            .join(connectors_t, connectors_t.c.id == sessions_t.c.connector_id)
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
                select(sessions_t, connectors_t.c.status.label("connector_status"))
                .join(connectors_t, connectors_t.c.id == sessions_t.c.connector_id)
                .where(sessions_t.c.id.in_(owned_ids))
            )
            async with self._engine.connect() as conn:
                view_rows = (await conn.execute(view_query)).mappings().all()
            by_id = {str(row["id"]): await self._session_from_row(row) for row in view_rows}
            sessions = [by_id[sid] for sid in ordered if sid in by_id]

        not_found = [sid for sid in ordered if sid not in owned_ids]
        return sessions, not_found


    async def set_session_status(self, session_id: str, status: str) -> SessionView:
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(sessions_t.c.status).where(sessions_t.c.id == session_id)
                )
            ).first()
            if row is None:
                raise KeyError(session_id)
            if row.status != status:
                await self._bump_session(conn, session_id)
                await conn.execute(
                    update(sessions_t).where(sessions_t.c.id == session_id).values(status=status)
                )
        return await self.get_session(session_id)


    async def refresh_session_status_from_timeline(self, session_id: str) -> SessionView:
        status = await self.derive_session_status(session_id)
        return await self.set_session_status(session_id, status)


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
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(
                        sessions_t.c.status,
                        sessions_t.c.title,
                        sessions_t.c.cwd,
                        sessions_t.c.external_session_id,
                        sessions_t.c.last_activity_at,
                    ).where(sessions_t.c.id == session_id)
                )
            ).first()
            if row is None:
                raise KeyError(session_id)
            semantic_fields = {
                "status",
                "title",
                "cwd",
                "external_session_id",
            }
            if any(field in values and values[field] != getattr(row, field) for field in semantic_fields):
                await self._bump_session(conn, session_id)
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
        latest = await self.timeline.latest_item(session_id)
        runtime = row["runtime"]
        override = _json_loads(row["runtime_settings_override"])
        runtime_override = override if isinstance(override, dict) else {}
        runtime_settings: dict[str, Any] | None = None
        try:
            runtime_settings = await self.get_effective_runtime_settings(session_id)
        except (KeyError, ValueError):
            runtime_settings = None
        title = row["title"]
        if not (isinstance(title, str) and title.strip()):
            derived = await self._derive_title_from_first_user_message(session_id)
            if derived:
                title = derived
                await self._lock_in_derived_title(session_id, derived)
        last_item_at = (latest.updatedAt or latest.completedAt or latest.createdAt) if latest else None
        sort_at = row["last_activity_at"] or last_item_at or row["created_at"]
        last_read_seq = int(row["last_read_seq"] or 0)
        updated_seq = int(row["updated_seq"] or 0)
        return SessionView(
            id=session_id,
            connectorId=row["connector_id"],
            connectorStatus=row["connector_status"],
            runtime=runtime,
            externalSessionId=row["external_session_id"],
            title=title,
            cwd=row["cwd"],
            status=row["status"],
            takeover=bool(row["takeover"]),
            pinned=bool(row["pinned"]),
            pinnedAt=row["pinned_at"],
            archived=bool(row["archived"]),
            archivedAt=row["archived_at"],
            unread=updated_seq > last_read_seq,
            lastReadSeq=last_read_seq,
            lastSyncedAt=row["last_synced_at"],
            sourceObservedAt=row["source_observed_at"],
            lastActivityAt=row["last_activity_at"],
            lastItemAt=last_item_at,
            lastItemOrderSeq=latest.orderSeq if latest else None,
            sortAt=sort_at,
            updatedSeq=updated_seq,
            runtimeSettings=runtime_settings,
            runtimeSettingsOverride=runtime_override or None,
        )
