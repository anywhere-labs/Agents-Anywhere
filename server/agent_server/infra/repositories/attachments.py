from __future__ import annotations

from agent_server.infra.repositories.store_support import *


class AttachmentRepositoryMixin:
    async def save_uploaded_file(
        self,
        *,
        connector_id: str,
        session_id: str,
        path: str,
        name: str | None,
        size: int,
        sha256: str,
        content_base64: str,
    ) -> dict[str, Any]:
        return await self.attachments.save_connector_upload(
            connector_id=connector_id,
            session_id=session_id,
            path=path,
            name=name,
            size=size,
            sha256=sha256,
            content_base64=content_base64,
        )


    async def save_user_uploaded_file(
        self,
        *,
        session_id: str,
        user_id: str,
        name: str,
        data: bytes,
        media_type: str | None = None,
    ) -> dict[str, Any]:
        return await self.attachments.save_user_upload(
            session_id=session_id,
            user_id=user_id,
            data=data,
            name=name,
            media_type=media_type,
        )


    async def read_uploaded_file(self, *, session_id: str, file_id: str, user_id: str) -> dict[str, Any]:
        return await self.attachments.read_user_file(
            session_id=session_id,
            file_id=file_id,
            user_id=user_id,
        )


    async def read_uploaded_file_for_connector(
        self, *, file_id: str, connector_id: str
    ) -> tuple[bytes, dict[str, Any]]:
        return await self.attachments.read_connector_handoff(
            file_id=file_id,
            connector_id=connector_id,
        )


    async def delete_uploaded_file(self, *, session_id: str, file_id: str) -> None:
        await self.attachments.delete_file(session_id=session_id, file_id=file_id)


    async def session_id_for_uploaded_file(self, file_id: str, connector_id: str) -> str | None:
        """Find the session this file belongs to, scoped to the connector.

        The connector handles many sessions; the file_id alone doesn't tell us
        which session it belongs to. We try every session owned by this connector
        and check disk — cheap with a small number of sessions; if this becomes
        hot we can index file_id → session_id in SQL.
        """
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(sessions_t.c.id)
                    .join(connectors_t, connectors_t.c.id == sessions_t.c.connector_id)
                    .where(
                        sessions_t.c.connector_id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).all()
        for row in rows:
            if await self.files.exists(row.id, file_id):
                return row.id
        return None

