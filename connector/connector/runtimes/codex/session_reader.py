from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    RuntimeModelCatalog,
    RuntimePermissionCatalog,
    RuntimeSessionStateCache,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.models import (
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionState,
)
from connector.runtimes.codex import sessions as codex_sessions
from connector.runtimes.codex import timeline as codex_timeline
from connector.runtimes.codex.pending_messages import PendingClientMessageRegistry
from connector.runtimes.codex.sdk.runtime_client import CodexRuntimeClient
from connector.runtimes.codex.selection import selections_from_thread_state

ListModelCatalog = Callable[[str | None, int], Awaitable[RuntimeModelCatalog]]
ListPermissionCatalog = Callable[[str | None, int], Awaitable[RuntimePermissionCatalog]]

EnsureStarted = Callable[[], Awaitable[None]]


def _session_sync_key(thread_id: str) -> str:
    return f"codex/session-sync/{thread_id}"


@dataclass(slots=True)
class CodexSessionReader:
    host: RuntimeHostClient
    client: CodexRuntimeClient | None
    session_states: RuntimeSessionStateCache
    ensure_started: EnsureStarted
    list_model_catalog: ListModelCatalog
    list_permission_catalog: ListPermissionCatalog
    pending_messages: PendingClientMessageRegistry | None = None

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        if self.client is None:
            return ()
        await self.ensure_started()
        params = {
            "limit": limit,
            "sortKey": "updated_at",
            **({"cursor": cursor} if cursor else {}),
        }
        result = await self.client.request("thread/list", params)
        sessions: list[SessionMeta] = []
        for thread_ref in codex_sessions.thread_refs_from_list_result(result):
            thread_id = codex_sessions.thread_id_from_result(thread_ref)
            if thread_id is None:
                continue
            session = await self._session_meta_from_thread_ref(
                thread_id,
                thread_ref,
                force=force,
            )
            sessions.append(session)
        return tuple(sessions[:limit])

    async def _session_meta_from_thread_ref(
        self,
        thread_id: str,
        thread_ref: dict[str, Any],
        force: bool,
    ) -> SessionMeta:
        local_state = codex_sessions.local_thread_state(thread_ref)
        sync_marker = codex_sessions.thread_sync_marker(thread_ref)
        sync_key = _session_sync_key(thread_id)
        previous_sync = await self.host.sync_state_read(sync_key)
        previous_marker = (
            previous_sync.get("marker") if isinstance(previous_sync, dict) else None
        )
        changed = force or sync_marker is None or previous_marker != sync_marker
        hidden = local_state in {"archived", "deleted", "unresumable"}
        title = codex_sessions.thread_title(thread_ref)
        cwd = codex_sessions.thread_cwd(thread_ref)
        ordering_time = codex_sessions.thread_ordering_time(thread_ref)
        session_id = codex_sessions.stable_session_id(self.host.connector_id, thread_id)
        sync_state = {
            "marker": sync_marker,
            "title": title,
            "cwd": cwd,
            "ordering_time": ordering_time,
            "local_state": local_state,
            "hidden": hidden,
            "session_id": session_id,
        }
        await self.host.sync_state_write(sync_key, sync_state)
        return SessionMeta(
            session_id=session_id,
            external_session_id=thread_id,
            runtime="codex",
            title=title,
            cwd=cwd,
            ordering_time=ordering_time,
            metadata={
                "local_state": local_state,
                "hidden": hidden,
                "source": "codex.thread/list",
                "sync": {
                    "key": sync_key,
                    "marker": sync_marker,
                    "changed": changed,
                    "requires_timeline_sync": changed and not hidden,
                    "previous_marker": previous_marker,
                },
            },
        )

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        cached = self.session_states.get(session_id)
        if cached is not None:
            return cached
        if external_session_id is None:
            return None
        selections = await self._read_session_selections(external_session_id)
        return SessionState(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="codex",
            status="idle",
            selections=selections,
            metadata={"source": "codex.thread/read.state"},
        )

    async def _read_session_selections(
        self,
        external_session_id: str,
    ) -> dict[str, str]:
        if self.client is None:
            return {}
        await self.ensure_started()
        result = await self.client.request(
            "thread/read",
            {
                "threadId": external_session_id,
                "includeTurns": False,
            },
        )
        thread = (
            result.get("thread") if isinstance(result.get("thread"), dict) else result
        )
        if not isinstance(thread, dict):
            return {}
        return await selections_from_thread_state(
            thread,
            lambda: self.list_model_catalog(None, 100),
            lambda: self.list_permission_catalog(None, 100),
        )

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int = 100,
    ) -> RuntimeTimelineSnapshot:
        if self.client is None or external_session_id is None:
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=external_session_id,
                runtime="codex",
                items=(),
                complete=True,
                metadata={"source": "codex.runtime.basic"},
            )
        await self.ensure_started()
        result = await self.client.request(
            "thread/read",
            {
                "threadId": external_session_id,
                "includeTurns": True,
            },
        )
        thread = (
            result.get("thread") if isinstance(result.get("thread"), dict) else result
        )
        items = codex_timeline.timeline_items_from_thread(
            session_id=session_id,
            external_session_id=external_session_id,
            thread=thread if isinstance(thread, dict) else {},
            limit=limit,
            pending_messages=self.pending_messages,
        )
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="codex",
            items=items,
            complete=True,
            metadata={"source": "codex.thread/read"},
        )
