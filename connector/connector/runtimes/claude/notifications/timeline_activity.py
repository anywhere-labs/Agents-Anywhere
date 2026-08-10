from __future__ import annotations

from dataclasses import dataclass

from connector.runtime_protocol import RuntimeTimelineItem, RuntimeTimelineSnapshot
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude.sessions.cache import ClaudeSessionStore


@dataclass(slots=True)
class ClaudeTimelineActivityHandler:
    host: RuntimeHostClient
    session_store: ClaudeSessionStore

    async def timeline_item_upsert(self, item: RuntimeTimelineItem) -> None:
        self.session_store.record_timeline_item(item)
        await self.host.timeline_item_upsert(item)

    async def timeline_sync(
        self,
        snapshot: RuntimeTimelineSnapshot,
        *,
        source: str,
    ) -> None:
        await self.host.timeline_sync(
            session_id=snapshot.session_id,
            runtime=snapshot.runtime,
            external_session_id=snapshot.external_session_id,
            items=snapshot.items,
            complete=snapshot.complete,
            metadata={
                **dict(snapshot.metadata),
                "source": source,
            },
        )
