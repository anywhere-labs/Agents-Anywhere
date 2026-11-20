from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

from sqlalchemy import select

from agent_server.infra.db import (
    connectors,
    instance_settings,
    session_shares,
    sessions,
)


class AttachmentRepositoryMixin:
    @asynccontextmanager
    async def attachment_write_fence(
        self, session_id: str, *, user_id: str | None = None
    ) -> AsyncIterator[None]:
        # Uploads and trusted share copies hold a shared lock until storage has published the file.
        query = select(sessions.c.id).where(sessions.c.id == session_id)
        if user_id is not None:
            query = query.join(connectors, connectors.c.id == sessions.c.connector_id).where(
                connectors.c.user_id == user_id, connectors.c.revoked == 0,
            )
        async with self._engine.begin() as conn:
            row = (await conn.execute(query.with_for_update(read=True, of=sessions))).first()
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

    async def attachment_purge_plan(self, key: str) -> tuple[datetime, list[str]] | None:
        async with self._engine.connect() as conn:
            cutoff = await conn.scalar(select(instance_settings.c.updated_at).where(
                instance_settings.c.key == key, instance_settings.c.value == "pending",
            ))
            if cutoff is None:
                return None
            ids = (await conn.scalars(select(sessions.c.id))).all()
        return datetime.fromisoformat(cutoff), list(ids)

    @asynccontextmanager
    async def attachment_purge_fence(self, session_id: str) -> AsyncIterator[set[str] | None]:
        async with self._engine.begin() as conn:
            session = await conn.scalar(select(sessions.c.id).where(sessions.c.id == session_id).with_for_update())
            if session is None:
                yield None
                return
            shares = await conn.scalars(select(session_shares.c.allowed_file_ids_json).where(
                session_shares.c.session_id == session_id,
            ))
            keep: set[str] = set()
            for encoded in shares:
                keep.update(json.loads(encoded or "[]"))
            yield keep
