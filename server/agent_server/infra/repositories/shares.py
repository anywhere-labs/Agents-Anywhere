from __future__ import annotations

import secrets
from typing import Any

from sqlalchemy import insert, select

from agent_server.core.utc import utc_now
from agent_server.infra.repositories.store_support import (
    _json_dumps,
    _json_loads,
    session_shares_t,
)


class SessionShareRepositoryMixin:
    async def create_session_share(
        self,
        *,
        user_id: str,
        session_id: str,
        scope: str,
        snapshot: dict[str, Any],
        allowed_file_ids: set[str],
    ) -> dict[str, Any]:
        share_id = f"shr_{secrets.token_urlsafe(24)}"
        created_at = utc_now()
        async with self._engine.begin() as connection:
            await connection.execute(
                insert(session_shares_t).values(
                    id=share_id,
                    user_id=user_id,
                    session_id=session_id,
                    scope=scope,
                    snapshot_json=_json_dumps(snapshot),
                    allowed_file_ids_json=_json_dumps(sorted(allowed_file_ids)),
                    created_at=created_at,
                )
            )
        return {
            "id": share_id,
            "userId": user_id,
            "sessionId": session_id,
            "scope": scope,
            "snapshot": snapshot,
            "allowedFileIds": sorted(allowed_file_ids),
            "createdAt": created_at,
        }

    async def get_session_share(self, share_id: str) -> dict[str, Any]:
        async with self._engine.connect() as connection:
            row = (
                await connection.execute(
                    select(session_shares_t).where(session_shares_t.c.id == share_id)
                )
            ).mappings().first()
        if row is None:
            raise KeyError(share_id)
        return {
            "id": row["id"],
            "userId": row["user_id"],
            "sessionId": row["session_id"],
            "scope": row["scope"],
            "snapshot": _json_loads(row["snapshot_json"]) or {},
            "allowedFileIds": _json_loads(row["allowed_file_ids_json"]) or [],
            "createdAt": row["created_at"],
        }
