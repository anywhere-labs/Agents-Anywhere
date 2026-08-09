from __future__ import annotations

from dataclasses import dataclass

from connector.logging import logger
from connector.runtime_protocol import RuntimeConfig
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude.domain.session import ClaudeSession
from connector.runtimes.claude.history.cursor import cursor_for, messages_after_cursor
from connector.runtimes.claude.history.state import ClaudeHistoryCursorStore
from connector.runtimes.claude.sdk.client import SdkLoader, load_sdk
from connector.runtimes.claude.sdk.history import (
    read_sdk_session_info,
    read_sdk_session_messages,
)
from connector.runtimes.claude.sessions.cache import ClaudeSessionStore
from connector.runtimes.claude.sessions.reader import (
    _history_items_from_messages,
    _sdk_session_metadata,
    _session_title,
    _string_attr,
    _timestamp_from_epoch,
)


@dataclass(slots=True)
class ClaudeHistorySyncer:
    config: RuntimeConfig
    host: RuntimeHostClient
    session_store: ClaudeSessionStore
    sdk_loader: SdkLoader | None
    cursor_store: ClaudeHistoryCursorStore

    async def sync_session_timeline(
        self,
        session_id: str,
        external_session_id: str | None,
    ) -> bool:
        if external_session_id is None:
            return False

        local_session = self.session_store.get(session_id, external_session_id)
        if local_session is not None and local_session.active_turn_id is not None:
            logger.debug(
                "Claude history sync skipped active session session_id={} external_session_id={}",
                session_id,
                external_session_id,
            )
            return True

        try:
            info, messages = await self._read_history(external_session_id)
        except Exception:  # noqa: BLE001
            logger.exception(
                "Claude history sync failed external_session_id={}",
                external_session_id,
            )
            return True

        cursor = cursor_for(info, messages)
        previous_cursor = await self.cursor_store.read(external_session_id)
        if previous_cursor == cursor:
            self.session_store.mark_synced(session_id, external_session_id)
            return True

        complete = previous_cursor is None
        sync_messages = messages if complete else messages_after_cursor(
            messages,
            previous_cursor,
        )
        session = _history_session(session_id, external_session_id, info)
        items = _history_items_from_messages(session, sync_messages)
        await self.host.timeline_sync(
            session_id=session_id,
            runtime="claude",
            external_session_id=external_session_id,
            items=items,
            complete=complete,
            metadata={
                "source": "claude.history.sync",
                "messageCount": len(messages),
                "syncedMessageCount": len(sync_messages),
                "sdk": _sdk_session_metadata(info),
            },
        )
        await self.cursor_store.write(external_session_id, cursor)
        self.session_store.mark_synced(session_id, external_session_id)
        return True

    async def mark_session_consumed(self, session: ClaudeSession) -> None:
        if session.external_session_id is None:
            return
        try:
            info, messages = await self._read_history(
                session.external_session_id,
                cwd=session.cwd,
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "Claude history cursor update failed external_session_id={}",
                session.external_session_id,
            )
            return
        await self.cursor_store.write(
            session.external_session_id,
            cursor_for(info, messages),
        )
        self.session_store.mark_synced(
            session.session_id,
            session.external_session_id,
        )

    async def _read_history(
        self,
        external_session_id: str,
        cwd: str | None = None,
    ) -> tuple[object | None, tuple[object, ...]]:
        sdk = load_sdk(self.sdk_loader)
        info = await read_sdk_session_info(
            sdk,
            session_id=external_session_id,
            directory=cwd,
        )
        messages = await read_sdk_session_messages(
            sdk,
            session_id=external_session_id,
            directory=cwd,
        )
        return info, messages


def _history_session(
    session_id: str,
    external_session_id: str,
    info: object | None,
) -> ClaudeSession:
    return ClaudeSession(
        session_id=session_id,
        external_session_id=external_session_id,
        title=_session_title(info),
        cwd=_string_attr(info, "cwd", "directory"),
        ordering_time=_timestamp_from_epoch(
            _sdk_session_metadata(info).get("last_modified")
        ),
    )
