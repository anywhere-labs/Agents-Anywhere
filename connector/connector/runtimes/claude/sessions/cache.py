from __future__ import annotations

from datetime import UTC, datetime

from connector.runtime_protocol import RuntimeTimelineItem, RuntimeTimelineSnapshot
from connector.runtime_protocol.models import SessionMeta
from connector.runtimes.claude.domain.session import ClaudeSession


class ClaudeSessionStore:
    def __init__(self, sessions: dict[str, ClaudeSession]) -> None:
        self._sessions = sessions

    def ensure(
        self,
        session_id: str,
        external_session_id: str | None = None,
        cwd: str | None = None,
        title: str | None = None,
    ) -> ClaudeSession:
        session = self._sessions.get(session_id)
        if session is None:
            session = ClaudeSession(
                session_id=session_id,
                external_session_id=external_session_id,
                cwd=cwd,
                title=title,
                ordering_time=_now_iso(),
            )
            self._sessions[session_id] = session
            return session
        if external_session_id:
            session.external_session_id = external_session_id
        if cwd:
            session.cwd = cwd
        if title:
            session.title = title
        if session.ordering_time is None:
            session.ordering_time = _now_iso()
        return session

    def update_meta(
        self,
        session: ClaudeSession,
        title: str | None = None,
        cwd: str | None = None,
    ) -> None:
        if title is not None:
            session.title = title
        if cwd is not None:
            session.cwd = cwd
        if session.ordering_time is None:
            session.ordering_time = _now_iso()

    def update_external_session_id(
        self,
        session: ClaudeSession,
        external_session_id: str,
    ) -> bool:
        if session.external_session_id == external_session_id:
            return False
        session.external_session_id = external_session_id
        return True

    def get(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> ClaudeSession | None:
        session = self._sessions.get(session_id)
        if session is not None:
            return session
        if external_session_id is not None:
            return self._session_by_external_id(external_session_id)
        return None

    def record_timeline_item(self, item: RuntimeTimelineItem) -> None:
        session = self.ensure(item.session_id)
        previous = session.timeline_items.get(item.id)
        session.timeline_items[item.id] = item
        if previous != item:
            session.timeline_revision += 1

    def mark_synced(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> None:
        session = self.get(session_id, external_session_id)
        if session is not None:
            session.synced_revision = session.timeline_revision

    def list_sessions(self, limit: int = 100) -> tuple[SessionMeta, ...]:
        sessions = sorted(
            self._sessions.values(),
            key=lambda session: session.ordering_time or "",
            reverse=True,
        )
        return tuple(self.session_meta(session) for session in sessions[:limit])

    def session_meta(self, session: ClaudeSession) -> SessionMeta:
        requires_timeline_sync = session.timeline_revision > session.synced_revision
        return SessionMeta(
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            runtime="claude",
            title=session.title,
            cwd=session.cwd,
            ordering_time=session.ordering_time,
            metadata={
                "source": "claude.session.local",
                "sync": {
                    "marker": str(session.timeline_revision),
                    "requires_timeline_sync": requires_timeline_sync,
                    "changed": requires_timeline_sync,
                    "previous_marker": str(session.synced_revision),
                },
            },
        )

    def snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        session = self._sessions.get(session_id)
        if session is None and external_session_id is not None:
            session = self._session_by_external_id(external_session_id)
        if session is None:
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=external_session_id,
                runtime="claude",
                items=(),
                complete=True,
                metadata={"source": "claude.session.local"},
            )
        items = tuple(
            sorted(session.timeline_items.values(), key=lambda item: item.order_seq)
        )
        if limit is not None:
            items = items[:limit]
        session.synced_revision = session.timeline_revision
        return RuntimeTimelineSnapshot(
            session_id=session.session_id,
            external_session_id=session.external_session_id,
            runtime="claude",
            items=items,
            complete=True,
            metadata={
                "source": "claude.session.local",
                "marker": str(session.timeline_revision),
            },
        )

    def _session_by_external_id(self, external_session_id: str) -> ClaudeSession | None:
        for session in self._sessions.values():
            if session.external_session_id == external_session_id:
                return session
        return None


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()
