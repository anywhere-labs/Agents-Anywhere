from __future__ import annotations

import time
import hashlib
import json
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from typing import Any

import asyncer
from openai_codex.generated.v2_all import Thread

from connector.logging import logger
from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
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
from connector.runtimes.codex.sessions.history_index import read_history_index, source_signature, valid_read_state
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
    _observed_threads: dict[str, dict[str, Any]] = field(default_factory=dict, init=False)

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
        self._observed_threads[thread_id] = thread_ref
        source = await asyncer.asyncify(source_signature)(thread_ref)
        if source is not None:
            # API timestamps have second precision and miss fast changes within a second.
            sync_marker = hashlib.sha256(json.dumps([sync_marker, source], sort_keys=True).encode()).hexdigest()
        sync_key = _session_sync_key(thread_id)
        previous_sync = await self.host.sync_state_read(sync_key)
        previous_marker = (
            previous_sync.get("marker") if isinstance(previous_sync, dict) else None
        )
        changed = force or sync_marker is None or previous_marker != sync_marker
        checkpoint = await self.host.sync_state_read(f"codex/timeline-sync/{thread_id}")
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
        if (not isinstance(checkpoint, dict) or checkpoint.get("version") != 1
                or checkpoint.get("sessionId") != session_id or not isinstance(checkpoint.get("items"), dict)
                or not all(isinstance(k, str) and isinstance(v, str) for k, v in checkpoint["items"].items())):
            changed = True
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
        checkpoint_key = f"codex/timeline-sync/{external_session_id}"
        previous = await self.host.sync_state_read(checkpoint_key) if external_session_id else None
        # Version changes deliberately invalidate projections from older implementations.
        old_items = previous.get("items") if isinstance(previous, Mapping) and previous.get("version") == 1 and previous.get("sessionId") == session_id else None
        valid = isinstance(old_items, dict) and all(isinstance(k, str) and isinstance(v, str) for k, v in old_items.items())
        # Capture before any history awaits: a newer scan must not be acknowledged here.
        pending = self._pending_sync_states.get(session_id)
        indexed = await self._read_indexed_snapshot(session_id, external_session_id, previous if valid else None)
        read_state = None
        prefix = {}
        if indexed is not None:
            snapshot, read_state, prefix = indexed
        else:
            snapshot = await self.get_session_snapshot(session_id, external_session_id)
        if snapshot is None:
            items = ()
        else:
            items = tuple(item for item in snapshot.items if item.type not in {"turn.start", "turn.end"})
        fingerprints = dict(prefix)
        fingerprints.update({
            item.id: hashlib.sha256(json.dumps(asdict(item), sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
            for item in items
        })
        removed = valid and bool(old_items.keys() - fingerprints.keys())
        if removed and prefix:
            # A replacement must contain the entire surviving timeline, not just its tail.
            snapshot = await self.get_session_snapshot(session_id, external_session_id)
            items = tuple(item for item in snapshot.items if item.type not in {"turn.start", "turn.end"})
            fingerprints = {item.id: hashlib.sha256(json.dumps(asdict(item), sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest() for item in items}
            read_state = None
        replacement = previous is not None and (not valid or removed)
        delta = items if not valid or replacement else tuple(item for item in items if old_items.get(item.id) != fingerprints[item.id])
        prepared_snapshot = replace(snapshot, items=delta, complete=bool(replacement)) if snapshot is not None and (delta or replacement) else None
        async def commit() -> None:
            if external_session_id:
                await self.host.sync_state_write(checkpoint_key, {"version": 1, "sessionId": session_id, "items": fingerprints,
                    **({"readState": read_state} if read_state is not None else {})})
            if pending is not None:
                sync_key, sync_state = pending
                await self.host.sync_state_write(sync_key, sync_state)
                if self._pending_sync_states.get(session_id) is pending:
                    self._pending_sync_states.pop(session_id, None)

        return PreparedSessionTimelineSync(snapshot=prepared_snapshot, commit=commit)

    async def _read_indexed_snapshot(
        self, session_id: str, external_session_id: str | None, previous: Mapping[str, Any] | None,
    ) -> tuple[RuntimeTimelineSnapshot | None, dict[str, Any], dict[str, str]] | None:
        page_reader = getattr(self.client, "list_thread_turns_page", None)
        if not external_session_id or not callable(page_reader) or self.timeline is None:
            return None
        await self.ensure_started()
        thread = self._observed_threads.get(external_session_id)
        if thread is None:
            result = await self.client.read_thread(external_session_id, include_turns=False)
            thread = result.thread.model_dump(mode="json", by_alias=True) if isinstance(result.thread, Thread) else dict(result.thread)
        index = await asyncer.asyncify(read_history_index)(thread)
        if index is None:
            return None
        old_items = previous["items"] if previous else {}
        old = previous.get("readState") if previous else None
        usable = valid_read_state(old, old_items)
        ids = index["ids"]
        start = 0
        if usable:
            old_index = old["index"]
            old_ids = old_index["ids"]
            # Only append preserves the prefix. Deletion, reorder, or source replacement
            # calibrates the entire history, even when the last turn still exists.
            same_source = all(index["source"].get(k) == old_index.get("source", {}).get(k) for k in ["path", "device", "inode"])
            usable = same_source and ids[:len(old_ids)] == old_ids
            if usable:
                changed = [n for n, id in enumerate(ids) if index["revisions"][id] != old_index["revisions"].get(id)]
                if not changed and index["settled"] and old_index.get("settled"):
                    # No API history calls on restart when the native index is unchanged.
                    return None, {**old, "index": index}, dict(old_items)
                # Always reread the previous tail, including an unfinished turn.
                start = min(changed + [max(0, len(old_ids) - 1)])
        wanted = ids[start:]
        descending_ids = list(reversed(ids))
        fetched = []
        cursor = None
        seen = set()
        while True:
            try:
                page = await page_reader(external_session_id, cursor=cursor, limit=20)
            except RuntimeInvalidRequestError:
                return None
            page_ids = [turn.get("id") for turn in page.turns]
            if page_ids != descending_ids[len(fetched):len(fetched) + len(page_ids)]:
                return None
            fetched.extend(page.turns)
            if len(fetched) >= len(wanted):
                if start == 0 and (page.next_cursor is not None or len(fetched) != len(wanted)):
                    return None
                break
            if page.next_cursor is None:
                return None
            if page.next_cursor in seen:
                raise RuntimeError("Codex history pagination repeated a cursor")
            seen.add(page.next_cursor)
            cursor = page.next_cursor
        if await asyncer.asyncify(read_history_index)(thread) != index:
            raise RuntimeError("Codex history changed while reading pages; retry before committing checkpoint")
        turns = list(reversed(fetched))[-len(wanted):] if wanted else []
        if any(item.get("type") == "contextCompaction" for turn in turns for item in turn.get("items", [])):
            return None
        projected = await asyncer.asyncify(self.timeline.items_from_thread_snapshot)(
            session_id=session_id, external_session_id=external_session_id,
            thread={"turns": turns}, limit=None)
        prefix_ids = ids[:start]
        counts = {id: old["counts"][id] for id in prefix_ids} if usable else {}
        item_ids = {id: old["itemIds"][id] for id in prefix_ids} if usable else {}
        offset = sum(counts.values())
        prefix = {id: old_items[id] for group in item_ids.values() for id in group}
        for id in wanted:
            counts[id] = 0
            item_ids[id] = []
        wanted_set = set(wanted)
        for item in projected:
            if item.turn_id not in wanted_set:
                return None
            counts[item.turn_id] += 1
            if item.type not in {"turn.start", "turn.end"}:
                item_ids[item.turn_id].append(item.id)
        items = tuple(replace(item, order_seq=item.order_seq + offset) for item in projected)
        snapshot = RuntimeTimelineSnapshot(session_id=session_id, external_session_id=external_session_id,
            runtime="codex", items=items, complete=False, metadata={"source": "codex.thread/turns/list"})
        state = {"version": 1, "index": index, "counts": counts, "itemIds": item_ids}
        logger.info("codex indexed history read thread_id={} total_turns={} fetched_turns={} projected_turns={} prefix_turns={}",
                    external_session_id, len(ids), len(fetched), len(wanted), start)
        return snapshot, state, prefix

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
            try:
                turns_result = await list_thread_turns(external_session_id)
            except RuntimeInvalidRequestError:
                result = await self.client.read_thread(
                    thread_id=external_session_id,
                    include_turns=True,
                )
            else:
                result = result.__class__(
                    thread=thread_with_raw_turns(
                        result.thread,
                        turns_result.turns,
                    )
                )
                snapshot_source = "codex.thread/turns/list"
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


def thread_with_raw_turns(
    thread: Thread | Mapping[str, Any],
    turns: tuple[Mapping[str, Any], ...],
) -> dict[str, Any]:
    if isinstance(thread, Thread):
        raw_thread = thread.model_dump(mode="json", by_alias=True)
    else:
        raw_thread = dict(thread)
    raw_thread["turns"] = [dict(turn) for turn in turns]
    return raw_thread
