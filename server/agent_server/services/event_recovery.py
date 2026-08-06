from __future__ import annotations

from typing import Protocol

from agent_server.core.events import (
    event_cursor,
    parse_event_cursor,
    protocol_event,
    timeline_events_from_items,
)
from agent_server.core.models import SessionView, TimelineItem
from agent_server.core.protocol import ProtocolEventRecoveryResponse
from agent_server.core.utc import utc_now
from agent_server.services.connector_presence import ConnectorPresencePort
from agent_server.services.effective_capabilities import (
    SessionCapabilityRepository,
    project_session_capabilities,
)

DEFAULT_RECOVERY_LIMIT = 500
DEFAULT_STABILITY_ATTEMPTS = 3


class EventRecoveryRepository(SessionCapabilityRepository, Protocol):
    async def get_session(
        self,
        session_id: str,
        *,
        user_id: str | None = None,
    ) -> SessionView: ...

    async def list_timeline_since(
        self,
        *,
        session_id: str,
        after_seq: int,
        limit: int,
    ) -> tuple[list[TimelineItem], bool]: ...


class EventRecoveryService:
    def __init__(
        self,
        store: EventRecoveryRepository,
        presence: ConnectorPresencePort,
        *,
        limit: int = DEFAULT_RECOVERY_LIMIT,
        stability_attempts: int = DEFAULT_STABILITY_ATTEMPTS,
    ) -> None:
        self._store = store
        self._presence = presence
        self._limit = limit
        self._stability_attempts = stability_attempts

    async def recover(
        self,
        session_id: str,
        *,
        after: str,
        user_id: str,
    ) -> ProtocolEventRecoveryResponse:
        after_sequence = parse_event_cursor(after)
        await self._store.get_session(session_id, user_id=user_id)
        current_sequence = await self._store.get_session_seq(session_id)
        if after_sequence > current_sequence:
            return self._snapshot_required(current_sequence)
        if after_sequence == current_sequence:
            return ProtocolEventRecoveryResponse(
                events=[],
                nextCursor=event_cursor(current_sequence),
                snapshotRequired=False,
                serverTime=utc_now(),
            )

        for _attempt in range(self._stability_attempts):
            start_sequence = await self._store.get_session_seq(session_id)
            session = await self._store.get_session(session_id, user_id=user_id)
            session, _runtime_capabilities, effective_capabilities = (
                await project_session_capabilities(
                    self._store,
                    self._presence,
                    session,
                    user_id=user_id,
                )
            )
            items, has_more = await self._store.list_timeline_since(
                session_id=session_id,
                after_seq=after_sequence,
                limit=self._limit,
            )
            current_sequence = await self._store.get_session_seq(session_id)
            if start_sequence == current_sequence:
                break
        else:
            return self._snapshot_required(current_sequence)

        if has_more:
            return self._snapshot_required(current_sequence)

        events = timeline_events_from_items(
            session_id,
            [item.model_dump(mode="json") for item in items],
        )
        if session.updatedSeq > after_sequence:
            session_payload = session.model_dump(mode="json")
            events.append(
                protocol_event(
                    session_id,
                    sequence=session.updatedSeq,
                    event_type="session.meta.updated",
                    payload={"session": session_payload},
                )
            )
            events.append(
                protocol_event(
                    session_id,
                    sequence=session.updatedSeq,
                    event_type="runtime.capability.updated",
                    payload={"capabilitySet": effective_capabilities.model_dump(mode="json")},
                )
            )
        events.sort(key=lambda event: (event.sequence, event.eventId))
        return ProtocolEventRecoveryResponse(
            events=events,
            nextCursor=event_cursor(current_sequence),
            snapshotRequired=False,
            serverTime=utc_now(),
        )

    @staticmethod
    def _snapshot_required(current_sequence: int) -> ProtocolEventRecoveryResponse:
        return ProtocolEventRecoveryResponse(
            events=[],
            nextCursor=event_cursor(current_sequence),
            snapshotRequired=True,
            serverTime=utc_now(),
        )
