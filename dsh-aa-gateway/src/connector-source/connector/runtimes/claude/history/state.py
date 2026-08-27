from __future__ import annotations

from dataclasses import dataclass

from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude.history.cursor import (
    ClaudeHistoryCursor,
    cursor_from_state,
    cursor_to_state,
)


@dataclass(slots=True)
class ClaudeHistoryCursorStore:
    host: RuntimeHostClient

    async def read(self, external_session_id: str) -> ClaudeHistoryCursor | None:
        return cursor_from_state(
            await self.host.sync_state_read(history_cursor_key(external_session_id))
        )

    async def write(
        self,
        external_session_id: str,
        cursor: ClaudeHistoryCursor,
    ) -> None:
        await self.host.sync_state_write(
            history_cursor_key(external_session_id),
            cursor_to_state(cursor),
        )


def history_cursor_key(external_session_id: str) -> str:
    return f"claude/history/cursor/{external_session_id}"
