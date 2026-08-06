from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from connector.core.config import ConnectorConfig
from connector.logging import logger
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeHostClient,
    RuntimeSupervisor,
    RuntimeUnavailableError,
)
from connector.runtime_protocol.models import SessionMeta

NotificationSender = Callable[[str, dict[str, Any]], Awaitable[None]]
PreferencesReader = Callable[[], dict[str, Any]]


class RuntimeSyncRunner:
    """Keeps runtime startup and background local-session sync out of the WS loop."""

    def __init__(
        self,
        config: ConnectorConfig,
        supervisor: RuntimeSupervisor,
        host: RuntimeHostClient,
        preferences_reader: PreferencesReader,
        send_notification: NotificationSender,
    ) -> None:
        self.config = config
        self.supervisor = supervisor
        self.host = host
        self.preferences_reader = preferences_reader
        self.send_notification = send_notification
        self._last_preferences: dict[str, Any] | None = None

    async def sync_existing_loop(self) -> None:
        if not self.config.sync_existing_on_connect:
            return
        while True:
            await self.sync_existing_once()
            await self.push_preferences_if_changed()
            await asyncio.sleep(self.config.sync_interval_seconds)

    async def sync_existing_once(self) -> None:
        for runtime_id in self.supervisor.runtimes:
            try:
                runtime = self.supervisor.resolve_runtime(runtime_id)
                sessions = await runtime.list_sessions(limit=100, force=False)
                for session in sessions:
                    await self.sync_existing_session(runtime, session)
            except RuntimeUnavailableError:
                continue
            except TimeoutError:
                logger.warning("existing {} session sync timed out", runtime_id)
            except Exception:  # noqa: BLE001
                logger.exception("existing {} session sync failed", runtime_id)

    async def sync_existing_session(
        self,
        runtime: AgentRuntime,
        session: SessionMeta,
    ) -> None:
        """Publish one discovered session and any required fresh timeline.

        Side effects:
        - upserts session meta to the platform immediately
        - when the runtime marks the session as changed, reads and pushes its
          timeline snapshot, current state, and active notices
        """
        await self.host.session_meta_upsert(
            session_id=session.session_id,
            runtime=session.runtime,
            external_session_id=session.external_session_id,
            title=session.title,
            cwd=session.cwd,
            ordering_time=session.ordering_time,
            metadata=session.metadata,
        )
        if not session_requires_timeline_sync(session):
            return
        snapshot = await runtime.get_session_snapshot(
            session.session_id,
            session.external_session_id,
            limit=100,
        )
        await self.host.timeline_sync(
            session_id=snapshot.session_id,
            runtime=snapshot.runtime,
            external_session_id=snapshot.external_session_id,
            items=snapshot.items,
            complete=snapshot.complete,
            metadata=snapshot.metadata,
        )
        state = await runtime.get_session_state(
            session.session_id,
            session.external_session_id,
        )
        if state is not None:
            await self.host.session_state_update(
                session_id=state.session_id,
                runtime=state.runtime,
                external_session_id=state.external_session_id,
                status=state.status,
                selections=state.selections,
                status_reason=state.status_reason,
                error=state.error,
                metadata=state.metadata,
            )
        notices = await runtime.get_session_notices(
            session.session_id,
            session.external_session_id,
        )
        for notice in notices:
            await self.host.notice_upsert(notice)

    async def push_preferences_if_changed(self) -> None:
        try:
            current = self.preferences_reader()
        except Exception:  # noqa: BLE001
            logger.exception("reading local preferences failed")
            return
        if not isinstance(current, dict):
            return
        # readAt is a per-call timestamp — strip it before diffing so we don't
        # push an "update" every cycle when nothing actually changed.
        if _preferences_signature(current) == _preferences_signature(
            self._last_preferences or {}
        ):
            return
        self._last_preferences = current
        await self.send_notification("connector.preferencesUpdated", current)


def _preferences_signature(prefs: dict[str, Any]) -> tuple[tuple[str, Any], ...]:
    """Stable signature ignoring volatile `readAt`.

    Lets us detect real user-driven changes instead of re-pushing every poll
    cycle.
    """
    return tuple(sorted((k, v) for k, v in prefs.items() if k != "readAt"))


def session_requires_timeline_sync(session: SessionMeta) -> bool:
    sync = session.metadata.get("sync")
    if not isinstance(sync, dict):
        return False
    return sync.get("requires_timeline_sync") is True
