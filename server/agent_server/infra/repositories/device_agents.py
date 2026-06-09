from __future__ import annotations

from agent_server.infra.repositories.store_support import *


class DeviceAgentsRepositoryMixin:
    async def get_connector_preferences(self, connector_id: str) -> dict[str, Any]:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(connectors_t.c.user_preferences).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
        if row is None:
            raise KeyError(connector_id)
        value = _json_loads(row.user_preferences)
        return value if isinstance(value, dict) else {}


    async def update_connector_preferences(
        self,
        connector_id: str,
        preferences: dict[str, Any],
    ) -> dict[str, Any]:
        now = utc_now()
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == connector_id, connectors_t.c.revoked == 0)
                .values(user_preferences=_json_dumps(preferences), updated_at=now)
            )
            if result.rowcount == 0:
                raise KeyError(connector_id)
        return preferences

    # ── Device agents (observed facts / desired intent / active set) ─────────
    #
    # `connectors.runtime_capabilities` stores internal v3 JSON:
    # `{version: 3, observed: {...}, desired: {...}, lastDiscoveredAt}`.
    # Discovery is input; the backend is the only place that turns it into
    # active connector work.


    async def get_device_agents(self, connector_id: str) -> dict[str, Any]:
        """Return the frontend-compatible DeviceAgentsState view."""
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(connectors_t.c.runtime_capabilities).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
        if row is None:
            raise KeyError(connector_id)
        return _agents_view_from_state(_normalize_agents_blob(_json_loads(row.runtime_capabilities)))


    async def get_active_runtimes(self, connector_id: str) -> list[str]:
        """Return runtimes the connector should actively sync."""
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(connectors_t.c.runtime_capabilities).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
        if row is None:
            raise KeyError(connector_id)
        return _active_runtimes_from_state(_normalize_agents_blob(_json_loads(row.runtime_capabilities)))


    async def apply_discovery(
        self,
        connector_id: str,
        raw_report: dict[str, Any],
    ) -> dict[str, Any]:
        """Store connector discovery and default-enable on the first report."""
        now = utc_now()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(connectors_t.c.runtime_capabilities).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
            if row is None:
                raise KeyError(connector_id)
            state = _normalize_agents_blob(_json_loads(row.runtime_capabilities))
            apply_defaults = state.get("defaultsAppliedAt") is None
            state["lastDiscoveredAt"] = now
            if apply_defaults:
                state["defaultsAppliedAt"] = now

            discovered_runtimes = raw_report.get("runtimes")
            if not isinstance(discovered_runtimes, dict):
                discovered_runtimes = {}

            observed: dict[str, Any] = state.get("observed") or {}
            desired: dict[str, Any] = state.get("desired") or {}
            for runtime, report in discovered_runtimes.items():
                if not isinstance(report, dict):
                    continue
                observed[runtime] = {"report": report, "observedAt": now}
                if apply_defaults and runtime not in desired and report_is_attachable(report):
                    desired[runtime] = {"enabled": True, "updatedAt": now}
            state["observed"] = observed
            state["desired"] = desired

            await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == connector_id, connectors_t.c.revoked == 0)
                .values(runtime_capabilities=_json_dumps(state), updated_at=now)
            )
        return _agents_view_from_state(state)


    async def observe_runtime(
        self,
        connector_id: str,
        runtime: str,
        report: dict[str, Any],
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """Persist one runtime observation without changing user intent."""
        now = utc_now()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(
                        connectors_t.c.runtime_capabilities,
                        connectors_t.c.user_id,
                    ).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
            if row is None:
                raise KeyError(connector_id)
            if user_id is not None and row.user_id != user_id:
                raise KeyError(connector_id)
            state = _normalize_agents_blob(_json_loads(row.runtime_capabilities))
            observed: dict[str, Any] = state.get("observed") or {}
            observed[runtime] = {"report": report, "observedAt": now}
            state["observed"] = observed
            state["lastDiscoveredAt"] = now
            await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == connector_id, connectors_t.c.revoked == 0)
                .values(runtime_capabilities=_json_dumps(state), updated_at=now)
            )
        return _agents_view_from_state(state)


    async def attach_runtime(
        self,
        connector_id: str,
        runtime: str,
        report: dict[str, Any],
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """Enable a runtime for this device and store its latest report."""
        now = utc_now()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(
                        connectors_t.c.runtime_capabilities,
                        connectors_t.c.user_id,
                    ).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
            if row is None:
                raise KeyError(connector_id)
            if user_id is not None and row.user_id != user_id:
                raise KeyError(connector_id)
            state = _normalize_agents_blob(_json_loads(row.runtime_capabilities))
            observed: dict[str, Any] = state.get("observed") or {}
            desired: dict[str, Any] = state.get("desired") or {}
            observed[runtime] = {"report": report, "observedAt": now}
            desired[runtime] = {"enabled": True, "updatedAt": now}
            state["observed"] = observed
            state["desired"] = desired
            state["lastDiscoveredAt"] = now
            await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == connector_id, connectors_t.c.revoked == 0)
                .values(runtime_capabilities=_json_dumps(state), updated_at=now)
            )
        return _agents_view_from_state(state)


    async def detach_runtime(
        self,
        connector_id: str,
        runtime: str,
        *,
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """Disable a runtime and delete every session it owns on this device."""
        now = utc_now()
        session_ids: list[str] = []
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(
                        connectors_t.c.runtime_capabilities,
                        connectors_t.c.user_id,
                    ).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
            if row is None:
                raise KeyError(connector_id)
            if user_id is not None and row.user_id != user_id:
                raise KeyError(connector_id)
            state = _normalize_agents_blob(_json_loads(row.runtime_capabilities))
            desired: dict[str, Any] = state.get("desired") or {}
            desired[runtime] = {"enabled": False, "updatedAt": now}
            state["desired"] = desired
            state["lastDiscoveredAt"] = now

            session_ids = [
                r.id
                for r in (
                    await conn.execute(
                        select(sessions_t.c.id).where(
                            sessions_t.c.connector_id == connector_id,
                            sessions_t.c.runtime == runtime,
                        )
                    )
                ).all()
            ]
            if session_ids:
                await conn.execute(
                    delete(sessions_t).where(sessions_t.c.id.in_(session_ids))
                )
            await conn.execute(
                update(connectors_t)
                .where(connectors_t.c.id == connector_id, connectors_t.c.revoked == 0)
                .values(runtime_capabilities=_json_dumps(state), updated_at=now)
            )

        files_root = getattr(self.files, "root", None)
        if files_root is not None:
            for sid in session_ids:
                session_dir = Path(files_root) / sid
                try:
                    if session_dir.exists():
                        await asyncio.to_thread(
                            shutil.rmtree, session_dir, ignore_errors=True
                        )
                except Exception:
                    logger.exception(
                        "file cleanup failed connector_id={} runtime={} session_id={}",
                        connector_id,
                        runtime,
                        sid,
                    )
        return _agents_view_from_state(state)


    async def is_runtime_disabled(self, connector_id: str, runtime: str) -> bool:
        """Return whether user intent disables this runtime on the device."""
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(connectors_t.c.runtime_capabilities).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
        if row is None:
            return False
        state = _normalize_agents_blob(_json_loads(row.runtime_capabilities))
        intent = (state.get("desired") or {}).get(runtime)
        return isinstance(intent, dict) and intent.get("enabled") is False


    async def get_session_runtime(self, session_id: str) -> str | None:
        """Look up the runtime for a session. Used by the ingest filter to
        drop timeline / approval notifications when the owning session's
        runtime has been Deleted on this device."""
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(sessions_t.c.runtime).where(sessions_t.c.id == session_id)
                )
            ).first()
        if row is None:
            return None
        return row.runtime

