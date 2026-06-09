from __future__ import annotations

from agent_server.infra.repositories.store_support import *


class ClaudeTranscriptRepositoryMixin:
    async def get_claude_transcript_cursor(self, session_id: str) -> dict[str, Any] | None:
        row = await self.claude_transcript_cursors.get(session_id)
        if row is None:
            return None
        return _claude_transcript_cursor_from_row(row)


    async def list_claude_transcript_cursors_for_connector(
        self, connector_id: str
    ) -> list[dict[str, Any]]:
        rows = await self.claude_transcript_cursors.list_for_connector(connector_id)
        return [_claude_transcript_cursor_from_row(row) for row in rows]


    async def update_claude_transcript_cursor(
        self,
        *,
        session_id: str,
        transcript_path: str,
        last_offset: int,
        last_event_key: str | None = None,
    ) -> dict[str, Any]:
        if last_offset < 0:
            raise ValueError("last_offset must be >= 0")
        await self.claude_transcript_cursors.upsert(
            session_id=session_id,
            transcript_path=transcript_path,
            last_offset=last_offset,
            last_event_key=last_event_key,
            updated_at=utc_now(),
        )
        cursor = await self.get_claude_transcript_cursor(session_id)
        assert cursor is not None
        return cursor


def _claude_transcript_cursor_from_row(row: Any) -> dict[str, Any]:
    return {
            "sessionId": row["session_id"],
            "transcriptPath": row["transcript_path"],
            "lastOffset": int(row["last_offset"]),
            "lastEventKey": row["last_event_key"],
            "updatedAt": row["updated_at"],
        }
