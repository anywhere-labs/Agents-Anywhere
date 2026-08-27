from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import asyncer
from openai_codex.generated.v2_all import Thread

from connector.logging import logger
from connector.runtime_protocol import (
    RuntimeModelCatalog,
    RuntimeInvalidRequestError,
    RuntimePermissionCatalog,
    RuntimeSessionSourceStateCache,
    RuntimeSessionStateCache,
    SessionSourceObservation,
    SessionSourceState,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtime_protocol.models import (
    PreparedSessionTimelineSync,
    RuntimeTimelineSnapshot,
    SessionMeta,
    SessionState,
)
from connector.runtimes.codex import timeline as codex_timeline
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.domain.pending_messages import (
    PendingClientMessageRegistry,
)
from connector.runtimes.codex.domain.selections import selections_from_thread_state
from connector.runtimes.codex.sdk.runtime_client import CodexRuntimeClient
from connector.runtimes.codex.sessions.inventory import list_all_codex_threads
from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator

ListModelCatalog = Callable[[str | None, int], Awaitable[RuntimeModelCatalog]]
ListPermissionCatalog = Callable[[str | None, int], Awaitable[RuntimePermissionCatalog]]

EnsureStarted = Callable[[], Awaitable[None]]


def _session_sync_key(thread_id: str) -> str:
    return f"codex/session-sync/{thread_id}"


def _utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


@dataclass(slots=True)
class CodexSessionReader:
    host: RuntimeHostClient
    client: CodexRuntimeClient | None
    session_states: RuntimeSessionStateCache
    source_states: RuntimeSessionSourceStateCache
    ensure_started: EnsureStarted
    list_model_catalog: ListModelCatalog
    list_permission_catalog: ListPermissionCatalog
    pending_messages: PendingClientMessageRegistry | None = None
    timeline: CodexTimelineAccumulator | None = None
    _pending_sync_states: dict[str, tuple[str, dict[str, Any]]] = field(
        default_factory=dict,
        init=False,
    )

    async def list_sessions(
        self,
        limit: int = 100,
        cursor: str | None = None,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        if self.client is None:
            return ()
        await self.ensure_started()
        started_at = time.monotonic()
        result = await self.client.list_threads(
            limit=limit,
            cursor=cursor,
            archived=False,
        )
        observed_at = _utc_now()
        sessions: list[SessionMeta] = []
        for thread_ref_mapping in result.threads:
            thread_ref = dict(thread_ref_mapping)
            thread_id = codex_sessions.thread_id_from_result(thread_ref)
            if thread_id is None:
                continue
            session = await self._session_meta_from_thread_ref(
                thread_id,
                thread_ref,
                force=force,
                availability="available",
                observed_at=observed_at,
            )
            sessions.append(session)
        elapsed_ms = (time.monotonic() - started_at) * 1000
        logger.info(
            "codex session list completed limit={} cursor_present={} force={} returned={} elapsed_ms={:.1f}",
            limit,
            cursor is not None,
            force,
            len(sessions),
            elapsed_ms,
        )
        return tuple(sessions[:limit])

    async def list_complete_session_inventory(
        self,
        page_size: int = 100,
        force: bool = False,
    ) -> tuple[SessionMeta, ...]:
        if self.client is None:
            return ()
        await self.ensure_started()
        observed_at = _utc_now()
        active_threads = await list_all_codex_threads(
            self.client,
            archived=False,
            page_size=page_size,
        )
        archived_threads = await list_all_codex_threads(
            self.client,
            archived=True,
            page_size=page_size,
        )
        sessions_by_thread_id: dict[str, SessionMeta] = {}
        for availability, threads in (
            ("available", active_threads),
            ("archived", archived_threads),
        ):
            for thread_ref_mapping in threads:
                thread_ref = dict(thread_ref_mapping)
                thread_id = codex_sessions.thread_id_from_result(thread_ref)
                if thread_id is None:
                    continue
                sessions_by_thread_id[thread_id] = (
                    await self._session_meta_from_thread_ref(
                        thread_id,
                        thread_ref,
                        force=force,
                        availability=availability,
                        observed_at=observed_at,
                    )
                )
        return tuple(sessions_by_thread_id.values())

    async def _session_meta_from_thread_ref(
        self,
        thread_id: str,
        thread_ref: dict[str, Any],
        force: bool,
        availability: str,
        observed_at: str,
    ) -> SessionMeta:
        local_state = codex_sessions.local_thread_state(thread_ref)
        sync_marker = codex_sessions.thread_sync_marker(thread_ref)
        sync_key = _session_sync_key(thread_id)
        previous_sync = await self.host.sync_state_read(sync_key)
        previous_marker = (
            previous_sync.get("marker") if isinstance(previous_sync, dict) else None
        )
        changed = force or sync_marker is None or previous_marker != sync_marker
        hidden = availability != "available" or local_state in {
            "archived",
            "deleted",
            "unresumable",
        }
        title = codex_sessions.thread_title(thread_ref)
        cwd = codex_sessions.thread_cwd(thread_ref)
        ordering_time = codex_sessions.thread_ordering_time(thread_ref)
        session_id = codex_sessions.stable_session_id(
            getattr(self.host, "session_namespace", self.host.connector_id),
            thread_id,
        )
        sync_state = {
            "marker": sync_marker,
            "title": title,
            "cwd": cwd,
            "ordering_time": ordering_time,
            "local_state": local_state,
            "hidden": hidden,
            "session_id": session_id,
        }
        requires_timeline_sync = changed and not hidden
        if requires_timeline_sync:
            self._pending_sync_states[session_id] = (sync_key, sync_state)
        else:
            await self.host.sync_state_write(sync_key, sync_state)
        source_state = SessionSourceState(
            availability="archived" if hidden else "available",
            reason="codex.thread/list archived" if hidden else "codex.thread/list active",
            observed_at=observed_at,
            observation_origin="inventory",
        )
        self.source_states.remember(
            SessionSourceObservation(
                session_id=session_id,
                external_session_id=thread_id,
                runtime="codex",
                state=source_state,
            )
        )
        return SessionMeta(
            session_id=session_id,
            external_session_id=thread_id,
            runtime="codex",
            title=title,
            cwd=cwd,
            ordering_time=ordering_time,
            source_state=source_state,
            metadata={
                "local_state": local_state,
                "hidden": hidden,
                "source": "codex.thread/list",
                "sync": {
                    "key": sync_key,
                    "marker": sync_marker,
                    "changed": changed,
                    "requires_timeline_sync": requires_timeline_sync,
                    "previous_marker": previous_marker,
                },
            },
        )
    async def prepare_session_timeline_sync(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> PreparedSessionTimelineSync:
        snapshot = await self.get_session_snapshot(
            session_id=session_id,
            external_session_id=external_session_id,
        )

        async def commit() -> None:
            pending = self._pending_sync_states.pop(session_id, None)
            if pending is None:
                return
            sync_key, sync_state = pending
            await self.host.sync_state_write(sync_key, sync_state)

        return PreparedSessionTimelineSync(snapshot=snapshot, commit=commit)

    async def get_session_state(
        self,
        session_id: str,
        external_session_id: str | None = None,
    ) -> SessionState | None:
        cached = self.session_states.get(session_id)
        if cached is None and external_session_id is not None:
            cached = self.session_states.get_by_external_session_id(
                external_session_id
            )
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
        started_at = time.monotonic()
        result = await self.client.read_thread(
            thread_id=external_session_id,
            include_turns=False,
        )
        if isinstance(result.thread, Thread):
            thread_state = thread_state_from_sdk_thread(result.thread)
        else:
            thread_state = dict(result.thread)
        if not thread_state:
            return {}
        selections = await selections_from_thread_state(
            thread_state,
            lambda: self.list_model_catalog(None, 100),
            lambda: self.list_permission_catalog(None, 100),
        )
        elapsed_ms = (time.monotonic() - started_at) * 1000
        logger.info(
            "codex session state read completed external_session_id={} selection_scopes={} elapsed_ms={:.1f}",
            external_session_id,
            sorted(selections.keys()),
            elapsed_ms,
        )
        return selections

    async def get_session_snapshot(
        self,
        session_id: str,
        external_session_id: str | None = None,
        limit: int | None = None,
    ) -> RuntimeTimelineSnapshot:
        if self.client is None or external_session_id is None:
            return RuntimeTimelineSnapshot(
                session_id=session_id,
                external_session_id=external_session_id,
                runtime="codex",
                items=(),
                complete=False,
                metadata={"source": "codex.runtime.basic"},
            )
        await self.ensure_started()
        started_at = time.monotonic()
        snapshot_source = "codex.thread/read"
        list_thread_turns = getattr(self.client, "list_thread_turns", None)
        if callable(list_thread_turns):
            result = await self.client.read_thread(
                thread_id=external_session_id,
                include_turns=False,
            )
            if isinstance(result.thread, Thread):
                try:
                    turns_result = await list_thread_turns(external_session_id)
                except RuntimeInvalidRequestError:
                    result = await self.client.read_thread(
                        thread_id=external_session_id,
                        include_turns=True,
                    )
                else:
                    result = result.__class__(
                        thread=result.thread.model_copy(
                            update={"turns": list(turns_result.turns)}
                        )
                    )
                    snapshot_source = "codex.thread/turns/list"
            else:
                result = await self.client.read_thread(
                    thread_id=external_session_id,
                    include_turns=True,
                )
        else:
            result = await self.client.read_thread(
                thread_id=external_session_id,
                include_turns=True,
            )
        read_elapsed_ms = (time.monotonic() - started_at) * 1000
        project_started_at = time.monotonic()
        if isinstance(result.thread, Thread) and self.timeline is not None:
            projections = await asyncer.asyncify(
                codex_timeline.timeline_projections_from_sdk_thread
            )(thread=result.thread, limit=limit)
            items = await asyncer.asyncify(
                self.timeline.items_from_snapshot_projections
            )(
                session_id=session_id,
                external_session_id=external_session_id,
                projections=projections,
            )
        elif self.timeline is not None:
            thread = dict(result.thread)
            items = await asyncer.asyncify(self.timeline.items_from_thread_snapshot)(
                session_id=session_id,
                external_session_id=external_session_id,
                thread=thread,
                limit=limit,
            )
        else:
            thread = dict(result.thread)
            items = await asyncer.asyncify(codex_timeline.timeline_items_from_thread)(
                session_id=session_id,
                external_session_id=external_session_id,
                thread=thread,
                limit=limit,
                pending_messages=self.pending_messages,
            )
        project_elapsed_ms = (time.monotonic() - project_started_at) * 1000
        logger.info(
            "codex session snapshot built session_id={} external_session_id={} limit={} items={} read_elapsed_ms={:.1f} project_elapsed_ms={:.1f}",
            session_id,
            external_session_id,
            limit,
            len(items),
            read_elapsed_ms,
            project_elapsed_ms,
        )
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external_session_id,
            runtime="codex",
            items=items,
            complete=False,
            metadata={"source": snapshot_source},
        )


def thread_state_from_sdk_thread(thread: Thread) -> dict[str, Any]:
    state: dict[str, Any] = {
        "id": thread.id,
        "modelProvider": thread.model_provider,
    }
    if thread.name is not None:
        state["name"] = thread.name
    return state
