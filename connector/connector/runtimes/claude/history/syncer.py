from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import asyncer

from connector.logging import logger
from connector.runtime_protocol import (
    PreparedSessionTimelineSync,
    RuntimeConfig,
    RuntimeTimelineSnapshot,
    RuntimeUpstreamError,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude.domain.pending_messages import (
    ClaudePendingClientMessageRegistry,
)
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
    _match_history_client_messages,
    _sdk_session_metadata,
    _session_title,
    _string_attr,
    _timestamp_from_epoch,
)
from connector.runtimes.claude.sessions.sync_state import (
    ClaudePendingSessionSync,
    ClaudeSessionSyncStateStore,
)


@dataclass(slots=True)
class ClaudeHistorySyncer:
    config: RuntimeConfig
    host: RuntimeHostClient
    session_store: ClaudeSessionStore
    sdk_loader: SdkLoader | None
    cursor_store: ClaudeHistoryCursorStore
    sync_states: ClaudeSessionSyncStateStore
    pending_messages: ClaudePendingClientMessageRegistry

    async def sync_session_timeline(
        self,
        session_id: str,
        external_session_id: str | None,
    ) -> bool:
        prepared = await self.prepare_session_timeline_sync(
            session_id,
            external_session_id,
        )
        if prepared is None:
            return False
        if prepared.snapshot is not None:
            snapshot = prepared.snapshot
            await self.host.timeline_sync(
                session_id=snapshot.session_id,
                runtime=snapshot.runtime,
                external_session_id=snapshot.external_session_id,
                items=snapshot.items,
                complete=snapshot.complete,
                metadata=snapshot.metadata,
            )
        if prepared.commit is not None:
            await prepared.commit()
        return True

    async def prepare_session_timeline_sync(
        self,
        session_id: str,
        external_session_id: str | None,
    ) -> PreparedSessionTimelineSync | None:
        if external_session_id is None:
            snapshot = self.session_store.snapshot(session_id=session_id)

            async def commit_local_snapshot() -> None:
                self.session_store.mark_synced(session_id)

            return PreparedSessionTimelineSync(
                snapshot=snapshot,
                commit=commit_local_snapshot,
            )
        pending_session_sync = self.sync_states.pending_for(external_session_id)

        local_session = self.session_store.get(session_id, external_session_id)
        if local_session is not None and local_session.active_turn_id is not None:
            logger.debug(
                "Claude history sync skipped active session session_id={} external_session_id={}",
                session_id,
                external_session_id,
            )
            return PreparedSessionTimelineSync(snapshot=None)
        if local_session is not None and (
            local_session.timeline_revision > local_session.synced_revision
        ):
            snapshot = self.session_store.snapshot(
                session_id=session_id,
                external_session_id=external_session_id,
            )

            async def commit_local_retry() -> None:
                self.session_store.mark_synced(session_id, external_session_id)

            return PreparedSessionTimelineSync(
                snapshot=snapshot,
                commit=commit_local_retry,
            )

        history_started_at = time.monotonic()
        try:
            info, messages = await self._read_history(external_session_id)
        except Exception as exc:
            logger.exception(
                "Claude history sync failed external_session_id={}",
                external_session_id,
            )
            raise RuntimeUpstreamError(
                f"Claude history sync failed for session {external_session_id}"
            ) from exc
        history_elapsed_ms = (time.monotonic() - history_started_at) * 1000

        cursor = cursor_for(info, messages)
        cursor_started_at = time.monotonic()
        previous_cursor = await self.cursor_store.read(external_session_id)
        cursor_elapsed_ms = (time.monotonic() - cursor_started_at) * 1000
        if previous_cursor == cursor:
            logger.info(
                "Claude history sync unchanged session_id={} external_session_id={} messages={} "
                "history_elapsed_ms={:.1f} cursor_elapsed_ms={:.1f}",
                session_id,
                external_session_id,
                len(messages),
                history_elapsed_ms,
                cursor_elapsed_ms,
            )
            return PreparedSessionTimelineSync(
                snapshot=None,
                commit=self.session_sync_commit(pending_session_sync),
            )

        if previous_cursor is None:
            sync_messages = messages
        else:
            sync_messages = messages_after_cursor(messages, previous_cursor)
        session = _history_session(session_id, external_session_id, info)
        match_started_at = time.monotonic()
        client_message_matches = await _match_history_client_messages(
            session=session,
            messages=sync_messages,
            pending_messages=self.pending_messages,
            prefer_latest=previous_cursor is None,
        )
        match_elapsed_ms = (time.monotonic() - match_started_at) * 1000
        projection_started_at = time.monotonic()
        items = await asyncer.asyncify(_history_items_from_messages)(
            session,
            sync_messages,
            client_message_matches=client_message_matches,
        )
        projection_elapsed_ms = (time.monotonic() - projection_started_at) * 1000
        logger.info(
            "Claude history sync prepared session_id={} external_session_id={} messages={} "
            "sync_messages={} items={} history_elapsed_ms={:.1f} cursor_elapsed_ms={:.1f} "
            "match_elapsed_ms={:.1f} projection_elapsed_ms={:.1f}",
            session_id,
            external_session_id,
            len(messages),
            len(sync_messages),
            len(items),
            history_elapsed_ms,
            cursor_elapsed_ms,
            match_elapsed_ms,
            projection_elapsed_ms,
        )
        snapshot = RuntimeTimelineSnapshot(
            session_id=session_id,
            runtime="claude",
            external_session_id=external_session_id,
            items=items,
            complete=False,
            metadata={
                "source": "claude.history.sync",
                "messageCount": len(messages),
                "syncedMessageCount": len(sync_messages),
                "sdk": _sdk_session_metadata(info),
            },
        )

        async def commit() -> None:
            await self.cursor_store.write(external_session_id, cursor)
            if pending_session_sync is not None:
                await self.sync_states.commit(pending_session_sync)
            self.session_store.mark_synced(session_id, external_session_id)

        return PreparedSessionTimelineSync(snapshot=snapshot, commit=commit)

    def session_sync_commit(
        self,
        pending_session_sync: ClaudePendingSessionSync | None,
    ) -> Callable[[], Awaitable[None]] | None:
        if pending_session_sync is None:
            return None

        async def commit() -> None:
            await self.sync_states.commit(pending_session_sync)

        return commit

    async def _read_history(
        self,
        external_session_id: str,
        cwd: str | None = None,
    ) -> tuple[object | None, tuple[object, ...]]:
        sdk = load_sdk(self.sdk_loader)
        info_started_at = time.monotonic()
        info = await read_sdk_session_info(
            sdk,
            session_id=external_session_id,
            directory=cwd,
        )
        info_elapsed_ms = (time.monotonic() - info_started_at) * 1000
        messages_started_at = time.monotonic()
        messages = await read_sdk_session_messages(
            sdk,
            session_id=external_session_id,
            directory=cwd,
        )
        logger.info(
            "Claude history SDK read completed external_session_id={} messages={} "
            "info_elapsed_ms={:.1f} messages_elapsed_ms={:.1f}",
            external_session_id,
            len(messages),
            info_elapsed_ms,
            (time.monotonic() - messages_started_at) * 1000,
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
