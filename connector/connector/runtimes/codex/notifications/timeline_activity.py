from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import RuntimeSessionStateCache, RuntimeTimelineItem
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator


@dataclass(slots=True)
class CodexTimelineActivityHandler:
    host: RuntimeHostClient
    session_states: RuntimeSessionStateCache
    active_turn_ids: dict[str, str]
    timeline: CodexTimelineAccumulator

    async def publish_compaction_outcome(
        self, session_id: str, thread_id: str, event: CodexSdkEvent
    ) -> None:
        turn_id = (
            event.turn_id
            or codex_sessions.turn_id_from_result(event.params)
            or self.active_turn_ids.get(session_id)
        )
        for item in self.timeline.finish_compaction_items(
            session_id, thread_id, turn_id, event.event_type
        ):
            await self.host.timeline_item_upsert(item)

    async def publish_item_activity(
        self,
        session_id: str,
        thread_id: str,
        event: CodexSdkEvent,
        item: RuntimeTimelineItem,
    ) -> None:
        """Publish item activity timeline and running state.

        Side effects:
        - refreshes active_turn_ids for the session
        - may update SessionState.status to running
        - upserts one RuntimeTimelineItem through the host
        """

        turn_id = event.turn_id or self.active_turn_ids.get(session_id)
        if event.is_running_item_event and turn_id is not None:
            self.active_turn_ids[session_id] = turn_id
        cached = self.session_states.get(session_id)
        if cached is not None and cached.status in {
            "waiting_approval",
            "blocked",
            "error",
        }:
            await self.host.timeline_item_upsert(item)
            return
        if event.is_running_item_event:
            await self.session_states.update(
                session_id=session_id,
                external_session_id=thread_id,
                status="running",
                metadata=running_item_metadata(event=event, turn_id=turn_id),
            )
        await self.host.timeline_item_upsert(item)


def running_item_metadata(
    event: CodexSdkEvent,
    turn_id: str | None,
) -> dict[str, Any]:
    return {
        "source": f"codex.{event.event_type}",
        **({"turn_id": turn_id} if turn_id else {}),
    }
