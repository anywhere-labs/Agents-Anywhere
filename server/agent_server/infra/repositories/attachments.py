from __future__ import annotations

from typing import Any


class AttachmentRepositoryMixin:
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
        self, *, session_id: str, file_id: str, connector_id: str
    ) -> tuple[bytes, dict[str, Any]]:
        return await self.attachments.read_connector_attachment(
            session_id=session_id,
            file_id=file_id,
            connector_id=connector_id,
        )


    async def delete_uploaded_file(self, *, session_id: str, file_id: str) -> None:
        await self.attachments.delete_file(session_id=session_id, file_id=file_id)
