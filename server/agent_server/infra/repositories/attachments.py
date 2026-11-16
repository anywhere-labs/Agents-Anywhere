from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import json
from typing import Any

from sqlalchemy import select

from agent_server.infra.db import connectors, session_shares, sessions


class AttachmentRepositoryMixin:
    @asynccontextmanager
    async def attachment_write_fence(
        self, session_id: str, *, user_id: str
    ) -> AsyncIterator[None]:
        # A device deletion waits for an in-flight upload, then removes it.
        # Uploads that arrive after deletion cannot leave orphaned blobs.
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(sessions.c.id)
                    .join(connectors, connectors.c.id == sessions.c.connector_id)
                    .where(
                        sessions.c.id == session_id,
                        connectors.c.user_id == user_id,
                        connectors.c.revoked == 0,
                    )
                    .with_for_update(read=True, of=sessions)
                )
            ).first()
            if row is None:
                raise KeyError(session_id)
            yield

    async def save_user_uploaded_file(
        self,
        *,
        session_id: str,
        user_id: str,
        name: str,
        data: bytes,
        media_type: str | None = None,
        file_id: str | None = None,
    ) -> dict[str, Any]:
        return await self.attachments.save_user_upload(
            session_id=session_id,
            user_id=user_id,
            data=data,
            name=name,
            media_type=media_type,
            **({"file_id": file_id} if file_id else {}),
        )

    async def read_uploaded_file(
        self, *, session_id: str, file_id: str, user_id: str
    ) -> dict[str, Any]:
        return await self.attachments.read_user_file(
            session_id=session_id,
            file_id=file_id,
            user_id=user_id,
        )

    async def read_uploaded_file_for_connector(
        self, *, session_id: str, file_id: str, connector_id: str
    ) -> tuple[bytes, dict[str, Any]]:
        return await self.attachments.read_connector_attachment(
            session_id=session_id,
            file_id=file_id,
            connector_id=connector_id,
        )

    async def delete_uploaded_file(self, *, session_id: str, file_id: str) -> None:
        await self.attachments.delete_file(session_id=session_id, file_id=file_id)

    async def attachment_purge_plan(self) -> list[tuple[str, set[str]]]:
        """Every session with the file ids its shares still expose (v2_60's attachment purge)."""

        async with self._engine.connect() as conn:
            session_ids = [str(row.id) for row in await conn.execute(select(sessions.c.id))]
            shares = (
                await conn.execute(select(session_shares.c.session_id, session_shares.c.allowed_file_ids_json))
            ).all()
        keep: dict[str, set[str]] = {}
        for row in shares:
            try:
                ids = json.loads(row.allowed_file_ids_json or "[]")
            except ValueError:
                ids = []
            keep.setdefault(str(row.session_id), set()).update(str(item) for item in ids if isinstance(item, str))
        return [(session_id, keep.get(session_id, set())) for session_id in session_ids]
