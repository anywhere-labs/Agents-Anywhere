from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    RuntimeSessionStateCache,
    RuntimeStatus,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude.domain.session import ClaudeSession


@dataclass(slots=True)
class ClaudeSessionStateHandler:
    host: RuntimeHostClient
    session_states: RuntimeSessionStateCache

    async def session_meta_upsert(
        self,
        session: ClaudeSession,
        *,
        source: str,
    ) -> None:
        await self.host.session_meta_upsert(
            session_id=session.session_id,
            runtime="claude",
            external_session_id=session.external_session_id,
            title=session.title,
            cwd=session.cwd,
            ordering_time=session.ordering_time,
            metadata={"source": source},
        )

    async def session_state_update(
        self,
        session: ClaudeSession,
        status: RuntimeStatus,
        *,
        selections: Mapping[str, str | None] | None = None,
        error: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> None:
        await self.session_states.update(
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            status=status,
            selections=selections,
            error=error,
            metadata=metadata,
        )
