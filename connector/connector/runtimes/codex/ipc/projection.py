"""Project followed IPC threads into runtime session facts.

A followed thread's ``conversationState`` (the owner window's UI model) is
mapped onto the runtime protocol: ``SessionMeta`` (title, cwd, ordering time),
``SessionState`` (status derived from ``threadRuntimeStatus`` and pending
requests), approval notices for pending server requests, the active turn id
and, when a timeline accumulator is provided, timeline items built from
``turnHistory``. Only the fields verified in ``docs/codex-ipc-takeover.md``
are read; everything else is ignored so that a Codex UI model change degrades
to missing detail instead of wrong state.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import (
    RuntimeSessionStateCache,
    RuntimeStatus,
    RuntimeTimelineItem,
    SessionNotice,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.domain.approvals import (
    approval_notice_from_request,
    is_approval_request,
)
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.domain.selections import (
    ModelCatalogReader,
    PermissionCatalogReader,
    selections_from_thread_state,
)
from connector.runtimes.codex.ipc.follower import FollowedThread, FollowerEvent
from connector.runtimes.codex.ipc.timeline import (
    active_turn_id,
    thread_snapshot_from_conversation_state,
    touches_turn_history,
)
from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator

IPC_SOURCE = "codex.ipc"
STATE_SOURCE_KEYS = (
    "threadRuntimeStatus",
    "requests",
    "title",
    "cwd",
    "latestModel",
    "latestReasoningEffort",
    "recencyAt",
    "updatedAt",
    "createdAt",
    "hasUnreadTurn",
    "originator",
    "source",
    "resumeState",
    "latestThreadSettings",
    "latestCollaborationMode",
    "currentPermissions",
)
ACTIVE_STATUSES: tuple[RuntimeStatus, ...] = ("running", "waiting", "waiting_approval")


@dataclass(slots=True)
class CodexIpcSessionProjector:
    host: RuntimeHostClient
    session_states: RuntimeSessionStateCache
    notices: CodexNoticeRegistry
    active_turn_ids: dict[str, str] | None = None
    timeline: CodexTimelineAccumulator | None = None
    read_model_catalog: ModelCatalogReader | None = None
    read_permission_catalog: PermissionCatalogReader | None = None
    _published_meta: dict[str, tuple[Any, ...]] = field(default_factory=dict, init=False)
    _notice_ids: dict[str, set[str]] = field(default_factory=dict, init=False)
    _timeline_items: dict[str, dict[str, RuntimeTimelineItem]] = field(
        default_factory=dict, init=False
    )
    _active_turns: dict[str, str] = field(default_factory=dict, init=False)

    @property
    def namespace(self) -> str:
        return getattr(self.host, "session_namespace", self.host.connector_id)

    def session_id_for(self, thread_id: str) -> str:
        # A session AA created has a server-assigned id; only threads AA has
        # never bound fall back to the derived id the server aliases.
        cached = self.session_states.get_by_external_session_id(thread_id)
        if cached is not None:
            return cached.session_id
        return codex_sessions.stable_session_id(self.namespace, thread_id)

    async def handle(self, event: FollowerEvent) -> None:
        """Mirror one follower event into host updates.

        Side effects:
        - upserts SessionMeta when title / cwd / ordering time changed
        - updates SessionState (deduplicated by the state cache)
        - upserts or closes approval notices for pending requests
        - publishes timeline items and turn-ended events
        """

        thread = event.thread
        touches_state = event.kind != "patches" or _touches_projection(event.patches)
        touches_history = event.kind == "snapshot" or touches_turn_history(event.patches)
        if not touches_state and not touches_history:
            return
        if thread.state is not None and thread.status == "following":
            if touches_state:
                await self._project_state(thread)
            if touches_history and self.timeline is not None:
                await self._project_timeline(thread, full=event.kind == "snapshot")
            return
        if thread.status in {"owner_lost", "offline", "unreachable", "no_owner"}:
            await self._project_detached(thread)

    async def _project_state(self, thread: FollowedThread) -> None:
        state = thread.state or {}
        session_id = self.session_id_for(thread.thread_id)
        title = codex_sessions.thread_title(dict(state))
        cwd = codex_sessions.thread_cwd(dict(state))
        ordering_time = codex_sessions.thread_ordering_time(dict(state))
        meta_key = (title, cwd, ordering_time, thread.owner_client_id)
        if self._published_meta.get(session_id) != meta_key:
            await self.host.session_meta_upsert(
                session_id=session_id,
                runtime="codex",
                external_session_id=thread.thread_id,
                title=title,
                cwd=cwd,
                ordering_time=ordering_time,
                metadata={
                    "source": IPC_SOURCE,
                    "attachment": "ipc",
                    "owner_client_id": thread.owner_client_id,
                    "originator": state.get("originator"),
                    "thread_source": state.get("source"),
                },
            )
            self._published_meta[session_id] = meta_key

        pending = _pending_requests(state)
        notice_ids = await self._sync_notices(session_id, thread, pending)
        status = _runtime_status(state, has_pending=bool(notice_ids))
        turn_id = await self._track_turn(session_id, thread, status)
        selections = await self._selections(state)
        await self.session_states.update(
            session_id=session_id,
            external_session_id=thread.thread_id,
            status=status,
            selections=selections or None,
            metadata={
                "source": IPC_SOURCE,
                "attachment": "ipc",
                "ipc": {
                    "ownerClientId": thread.owner_client_id,
                    "revision": thread.revision,
                    "threadRuntimeStatus": state.get("threadRuntimeStatus"),
                    "pendingRequests": len(pending),
                },
                **({"notice_id": min(notice_ids)} if notice_ids else {}),
                **({"turn_id": turn_id} if turn_id else {}),
            },
        )

    async def _selections(self, state: Mapping[str, Any]) -> dict[str, str]:
        """Map the owner's model and permission settings to catalog selections."""

        if self.read_model_catalog is None or self.read_permission_catalog is None:
            return {}
        settings = ipc_settings_state(state)
        if not settings:
            return {}
        try:
            return await selections_from_thread_state(
                settings, self.read_model_catalog, self.read_permission_catalog
            )
        except Exception as exc:  # noqa: BLE001 - catalogs may be unavailable
            logger.debug("codex ipc selection mapping failed error={}", exc)
            return {}

    async def _track_turn(
        self,
        session_id: str,
        thread: FollowedThread,
        status: RuntimeStatus,
    ) -> str | None:
        current = active_turn_id(thread.state or {}) if status in ACTIVE_STATUSES else None
        previous = self._active_turns.get(session_id)
        if current is not None:
            if current != previous:
                self._active_turns[session_id] = current
                if self.active_turn_ids is not None:
                    self.active_turn_ids[session_id] = current
                if self.timeline is not None:
                    self.timeline.begin_turn(thread.thread_id, current)
            return current
        if previous is not None:
            self._active_turns.pop(session_id, None)
            if self.active_turn_ids is not None and self.active_turn_ids.get(session_id) == previous:
                self.active_turn_ids.pop(session_id, None)
            if self.timeline is not None:
                self.timeline.end_turn(thread.thread_id, previous)
            await self.host.session_turn_ended(
                session_id=session_id,
                runtime="codex",
                external_session_id=thread.thread_id,
                turn_id=previous,
                outcome="completed",
                metadata={"source": f"{IPC_SOURCE}.turn/completed"},
            )
        return None

    async def _project_timeline(self, thread: FollowedThread, *, full: bool) -> None:
        assert self.timeline is not None
        session_id = self.session_id_for(thread.thread_id)
        snapshot = thread_snapshot_from_conversation_state(thread.state or {})
        items = self.timeline.items_from_thread_snapshot(
            session_id=session_id,
            external_session_id=thread.thread_id,
            thread=snapshot,
            limit=None,
        )
        known = self._timeline_items.get(session_id)
        if full or known is None:
            await self.host.timeline_sync(
                session_id=session_id,
                runtime="codex",
                items=items,
                external_session_id=thread.thread_id,
                complete=True,
                metadata={"source": f"{IPC_SOURCE}.snapshot", "revision": thread.revision},
            )
            self._timeline_items[session_id] = {item.id: item for item in items}
            return
        for item in items:
            previous = known.get(item.id)
            if (
                previous is not None
                and previous.content_hash == item.content_hash
                and previous.status == item.status
            ):
                continue
            known[item.id] = item
            await self.host.timeline_item_upsert(item)

    async def _project_detached(self, thread: FollowedThread) -> None:
        session_id = self.session_id_for(thread.thread_id)
        if self.session_states.get(session_id) is None:
            # Never seen through IPC; nothing to downgrade.
            return
        await self._sync_notices(session_id, thread, [])
        self._active_turns.pop(session_id, None)
        self._timeline_items.pop(session_id, None)
        await self.session_states.update(
            session_id=session_id,
            external_session_id=thread.thread_id,
            status="idle",
            metadata={
                "source": IPC_SOURCE,
                "attachment": "none",
                "ipc": {
                    "ownerClientId": None,
                    "revision": None,
                    "followStatus": thread.status,
                    "error": thread.error,
                },
            },
        )

    async def _sync_notices(
        self,
        session_id: str,
        thread: FollowedThread,
        pending: list[Mapping[str, Any]],
    ) -> set[str]:
        current: set[str] = set()
        for request in pending:
            method = _first_string(request, "method")
            params = request.get("params")
            request_id = request.get("requestId", request.get("id"))
            if not method or not isinstance(params, Mapping) or request_id is None:
                continue
            if not is_approval_request(method):
                logger.debug(
                    "codex ipc pending request not projected method={} thread={}",
                    method,
                    thread.thread_id,
                )
                continue
            notice = approval_notice_from_request(
                session_id=session_id,
                thread_id=thread.thread_id,
                method=method,
                params=params,
                request_id=request_id,
                turn_id=_first_string(params, "turnId", "turn_id"),
            )
            notice = _with_ipc_source(notice, thread)
            current.add(notice.notice_id)
            existing = self.notices.get(notice.notice_id)
            if existing is not None and existing.status not in {"open", "responding"}:
                continue
            if existing is None:
                self.notices.upsert(notice)
                await self.host.notice_upsert(notice)
        previous = self._notice_ids.get(session_id, set())
        for stale in previous - current:
            existing = self.notices.get(stale)
            if existing is None or existing.status not in {"open", "responding"}:
                continue
            closed = self.notices.transition(
                stale,
                status="resolved",
                response_required=False,
                blocking=None,
                actions=(),
                context={"approvalStatus": "resolved"},
                metadata={"source": IPC_SOURCE, "close_reason": "request no longer pending"},
            )
            if closed is not None:
                await self.host.notice_upsert(closed)
        self._notice_ids[session_id] = current
        return current


def ipc_settings_state(state: Mapping[str, Any]) -> dict[str, Any]:
    """Flatten the owner's settings into the keys ``selections_from_thread_state`` reads."""

    settings = state.get("latestThreadSettings")
    settings = settings if isinstance(settings, Mapping) else {}
    permissions = state.get("currentPermissions")
    permissions = permissions if isinstance(permissions, Mapping) else {}
    collaboration = state.get("latestCollaborationMode")
    collaboration_settings = (
        collaboration.get("settings") if isinstance(collaboration, Mapping) else None
    )
    collaboration_settings = (
        collaboration_settings if isinstance(collaboration_settings, Mapping) else {}
    )
    # latestThreadSettings is what the next turn uses, including a change a
    # follower just applied; latestModel / currentPermissions lag until that
    # turn runs, so they only fill keys the settings lack.
    flat: dict[str, Any] = {}
    model = settings.get("model") or state.get("latestModel") or collaboration_settings.get("model")
    if isinstance(model, str) and model:
        flat["model"] = model
    effort = (
        settings.get("effort")
        or state.get("latestReasoningEffort")
        or collaboration_settings.get("reasoning_effort")
    )
    if isinstance(effort, str) and effort:
        flat["reasoningEffort"] = effort
    for key in ("approvalPolicy", "approvalsReviewer", "sandboxPolicy"):
        value = settings.get(key)
        if value is None:
            value = permissions.get(key)
        if value is not None:
            flat[key] = value
    return flat


def _runtime_status(state: Mapping[str, Any], *, has_pending: bool) -> RuntimeStatus:
    if has_pending:
        return "waiting_approval"
    runtime_status = state.get("threadRuntimeStatus")
    kind = runtime_status.get("type") if isinstance(runtime_status, Mapping) else None
    if kind == "active":
        flags = runtime_status.get("activeFlags") if isinstance(runtime_status, Mapping) else None
        flags = flags if isinstance(flags, list) else []
        if "waitingOnApproval" in flags:
            return "waiting_approval"
        if "waitingOnUserInput" in flags:
            return "waiting"
        return "running"
    if kind == "systemError":
        return "error"
    return "idle"


def _pending_requests(state: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    requests = state.get("requests")
    if not isinstance(requests, list):
        return []
    return [request for request in requests if isinstance(request, Mapping)]


def _touches_projection(patches: tuple[Mapping[str, Any], ...]) -> bool:
    for patch in patches:
        path = patch.get("path")
        if isinstance(path, (list, tuple)) and path and path[0] in STATE_SOURCE_KEYS:
            return True
    return False


def _first_string(mapping: Mapping[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = mapping.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _with_ipc_source(notice: SessionNotice, thread: FollowedThread) -> SessionNotice:
    return replace(
        notice,
        metadata={
            **dict(notice.metadata),
            "transport": "ipc",
            "owner_client_id": thread.owner_client_id,
        },
    )
