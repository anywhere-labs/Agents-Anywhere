from __future__ import annotations

from agent_server.infra.repositories.store_support import *


class ActiveRunRepositoryMixin:
    async def start_active_run(
        self,
        *,
        session_id: str,
        runtime: str,
        status: str = "running",
        run_mode: str | None = None,
        external_session_id: str | None = None,
        turn_id: str | None = None,
        params: dict[str, Any] | None = None,
    ) -> None:
        now = utc_now()
        await self.active_runs.upsert(
            session_id=session_id,
            runtime=runtime,
            run_mode=run_mode,
            external_session_id=external_session_id,
            turn_id=turn_id,
            status=status,
            params_json=_json_dumps(params) if params is not None else None,
            started_at=now,
            updated_at=now,
        )


    async def update_active_run_turn_id(self, session_id: str, turn_id: str) -> None:
        await self.active_runs.update_turn_id(
            session_id,
            turn_id=turn_id,
            updated_at=utc_now(),
        )


    async def get_active_run(self, session_id: str) -> dict[str, Any] | None:
        row = await self.active_runs.get(session_id)
        if row is None:
            return None
        params = _json_loads(row["params_json"])
        return {
            "sessionId": row["session_id"],
            "runtime": row["runtime"],
            "runMode": row["run_mode"],
            "externalSessionId": row["external_session_id"],
            "turnId": row["turn_id"],
            "status": row["status"],
            "params": params if isinstance(params, dict) else None,
            "startedAt": row["started_at"],
            "updatedAt": row["updated_at"],
        }


    async def clear_active_run(self, session_id: str) -> None:
        await self.active_runs.delete(session_id)

