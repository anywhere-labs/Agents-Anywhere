from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol.host import RuntimeHostClient


@dataclass(frozen=True, slots=True)
class ClaudePendingSessionSync:
    external_session_id: str
    sync_key: str
    state: dict[str, Any]


@dataclass(slots=True)
class ClaudeSessionSyncStateStore:
    host: RuntimeHostClient
    pending_by_external_session_id: dict[str, ClaudePendingSessionSync] = field(
        default_factory=dict
    )

    def stage(
        self,
        *,
        external_session_id: str,
        sync_key: str,
        state: dict[str, Any],
    ) -> ClaudePendingSessionSync:
        """Stage a scanner marker without advancing durable sync state."""

        pending = ClaudePendingSessionSync(
            external_session_id=external_session_id,
            sync_key=sync_key,
            state=dict(state),
        )
        self.pending_by_external_session_id[external_session_id] = pending
        return pending

    def pending_for(
        self,
        external_session_id: str,
    ) -> ClaudePendingSessionSync | None:
        return self.pending_by_external_session_id.get(external_session_id)

    async def commit(self, pending: ClaudePendingSessionSync) -> None:
        """Persist one marker after its corresponding platform publish succeeds."""

        await self.host.sync_state_write(pending.sync_key, pending.state)
        current = self.pending_by_external_session_id.get(pending.external_session_id)
        if current == pending:
            self.pending_by_external_session_id.pop(pending.external_session_id, None)
