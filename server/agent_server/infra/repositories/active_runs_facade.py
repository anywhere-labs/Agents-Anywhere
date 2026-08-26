from __future__ import annotations

from agent_server.infra.repositories.store_support import *


class ActiveRunRepositoryMixin:
    async def start_active_run(
        self,
        *,
        session_id: str,
        runtime: str,
        runtime_id: str | None = None,
        status: str = "running",
        external_session_id: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> None:
        identity = RuntimeIdentity.create(
            runtime_type=runtime,
            runtime_id=runtime_id or runtime,
        )
        now = utc_now()
        started = await self.active_runs.upsert(
            session_id=session_id,
            runtime=str(identity.runtime_type),
            runtime_id=str(identity.runtime_id),
            external_session_id=external_session_id,
            status=status,
            params_json=_json_dumps(params) if params is not None else None,
            started_at=now,
            updated_at=now,
        )
        if started:
            await self.touch_session_sort_at(session_id, sort_at=now)

    async def get_active_run(self, session_id: str) -> dict[str, Any] | None:
        row = await self.active_runs.get(session_id)
        if row is None:
            return None
        params = _json_loads(row["params_json"])
        return {
            "sessionId": row["session_id"],
            "runtime": row["runtime"],
            "runtimeId": row["runtime_id"],
            "externalSessionId": row["external_session_id"],
            "status": row["status"],
            "params": params if isinstance(params, dict) else None,
            "startedAt": row["started_at"],
            "updatedAt": row["updated_at"],
        }


    async def clear_active_run(self, session_id: str) -> None:
        await self.active_runs.delete(session_id)
