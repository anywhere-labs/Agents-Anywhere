"""Owner side of the Codex IPC owner/follower protocol.

When the Connector's own app-server holds a thread (started from a phone, or
resumed because nobody else held it), Codex IDE and desktop windows that open
the same thread discover the Connector as the owner, follow it and drive it
through ``thread-follower-*`` requests. This module answers discovery for
owned threads, serves ``conversationState`` snapshots built from the
Connector's app-server, re-publishes them when the thread changes, and executes
follower requests against the app-server.

Followers always accept a full snapshot, so the owner re-sends snapshots on
change instead of computing JSON patches.
"""

from __future__ import annotations

import asyncio
import mimetypes
import os
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import RuntimeSessionStateCache, SessionState
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain import sessions as codex_sessions
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.domain.selections import (
    CodexModelSettings,
    CodexPermissionSettings,
    ModelCatalogReader,
    PermissionCatalogReader,
    model_settings_from_selection,
    permission_settings_from_selection,
    selections_from_thread_state,
)
from connector.runtimes.codex.ipc.client import CodexIpcClient, IpcBroadcast, IpcRequest
from connector.runtimes.codex.ipc.control import permission_block
from connector.runtimes.codex.ipc.follower import LOCAL_HOST_ID
from connector.runtimes.codex.sdk.runtime_client import (
    CodexInterruptTurnRequest,
    CodexRuntimeClient,
    CodexStartTurnRequest,
    CodexSteerTurnRequest,
    CodexTurnInputAttachment,
)
from connector.runtimes.codex.sessions.reader import thread_with_raw_turns

DEFAULT_PUBLISH_DELAY = 0.3
STATE_VERSION_NOTE = "agents-anywhere-owner"

FOLLOWER_METHODS = (
    "thread-follower-start-turn",
    "thread-follower-steer-turn",
    "thread-follower-interrupt-turn",
    "thread-follower-command-approval-decision",
    "thread-follower-file-approval-decision",
    "thread-follower-permissions-request-approval-response",
    "thread-follower-submit-user-input",
    "thread-follower-submit-mcp-server-elicitation-response",
    "thread-follower-load-complete-history",
    "thread-follower-read-model-settings",
    "thread-follower-update-thread-settings",
    "thread-follower-update-daybreak",
    "thread-follower-compact-thread",
    "thread-follower-set-queued-follow-ups-state",
    "thread-follower-remove-queued-message",
    "thread-follower-clear-queued-messages",
)

IsFollowedElsewhere = Callable[[str], bool]
SessionIdFor = Callable[[str], str]
Clock = Callable[[], float]
ApplySelections = Callable[[str, str, Mapping[str, str | None]], Awaitable[Any]]


@dataclass(slots=True)
class CodexIpcOwnerService:
    client: CodexIpcClient
    sdk: CodexRuntimeClient
    session_states: RuntimeSessionStateCache
    notices: CodexNoticeRegistry
    active_turn_ids: dict[str, str]
    session_id_for: SessionIdFor
    is_followed_elsewhere: IsFollowedElsewhere = lambda thread_id: False
    host: RuntimeHostClient | None = None
    host_id: str = LOCAL_HOST_ID
    publish_delay: float = DEFAULT_PUBLISH_DELAY
    read_model_catalog: ModelCatalogReader | None = None
    read_permission_catalog: PermissionCatalogReader | None = None
    apply_selections: ApplySelections | None = None
    followers: dict[str, set[str]] = field(default_factory=dict, init=False)
    revisions: dict[str, int] = field(default_factory=dict, init=False)
    _publish_handles: dict[str, asyncio.TimerHandle] = field(default_factory=dict, init=False)
    _publish_tasks: set[asyncio.Task[None]] = field(default_factory=set, init=False)
    _unsubscribe: list[Callable[[], None]] = field(default_factory=list, init=False)
    _attached: bool = field(default=False, init=False)

    # -- lifecycle -----------------------------------------------------------

    def attach(self) -> None:
        if self._attached:
            return
        self._attached = True
        self._unsubscribe.append(
            self.client.add_request_handler(
                "thread-owner-discovery", self._can_handle_discovery, self._handle_discovery
            )
        )
        for method in FOLLOWER_METHODS:
            self._unsubscribe.append(
                self.client.add_request_handler(method, self._can_handle_follower, self._handle_follower)
            )
        self._unsubscribe.extend(
            (
                self.client.add_broadcast_handler(
                    "thread-stream-following-changed", self._on_following_changed
                ),
                self.client.add_broadcast_handler(
                    "client-status-changed", self._on_client_status_changed
                ),
                self.client.add_broadcast_handler(
                    "ipc-connection-reset", self._on_connection_reset
                ),
            )
        )

    def detach(self) -> None:
        for unsubscribe in self._unsubscribe:
            unsubscribe()
        self._unsubscribe.clear()
        for handle in self._publish_handles.values():
            handle.cancel()
        self._publish_handles.clear()
        for task in list(self._publish_tasks):
            task.cancel()
        self._publish_tasks.clear()
        self.followers.clear()
        self._attached = False

    # -- ownership -----------------------------------------------------------

    def owns(self, thread_id: str) -> bool:
        """Whether this Connector's app-server is the holder of ``thread_id``.

        Threads reached through the IPC follower belong to another window. Any
        other thread this runtime has projected from its own app-server events
        counts as ours; if the app-server unloaded it meanwhile, follower
        requests simply resume it here.
        """

        if self.is_followed_elsewhere(thread_id):
            return False
        state = self.session_states.get_by_external_session_id(thread_id)
        if state is None:
            return False
        return state.metadata.get("attachment") != "ipc"

    def owned_threads_with_followers(self) -> list[str]:
        return [thread_id for thread_id, clients in self.followers.items() if clients]

    # -- change notifications ------------------------------------------------

    def notify_state(self, state: SessionState) -> None:
        if state.external_session_id:
            self.notify_thread(state.external_session_id)

    def notify_thread(self, thread_id: str) -> None:
        """Schedule a snapshot re-publish for followers of ``thread_id``."""

        if not self.followers.get(thread_id):
            return
        if thread_id in self._publish_handles:
            return
        loop = asyncio.get_running_loop()
        self._publish_handles[thread_id] = loop.call_later(
            self.publish_delay, self._publish_later, thread_id
        )

    def _publish_later(self, thread_id: str) -> None:
        self._publish_handles.pop(thread_id, None)
        task = asyncio.create_task(self.publish(thread_id))
        self._publish_tasks.add(task)
        task.add_done_callback(self._publish_tasks.discard)

    async def publish(self, thread_id: str, targets: list[str] | None = None) -> int | None:
        """Send a fresh snapshot to ``targets`` (default: every follower)."""

        recipients = list(targets) if targets is not None else sorted(self.followers.get(thread_id, ()))
        if not recipients:
            return None
        try:
            state = await self.build_conversation_state(thread_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("codex ipc owner snapshot failed thread={} error={}", thread_id, exc)
            return None
        revision = self.revisions.get(thread_id, 0) + 1
        self.revisions[thread_id] = revision
        try:
            await self.client.broadcast(
                "thread-stream-state-changed",
                {
                    "conversationId": thread_id,
                    "hostId": self.host_id,
                    "change": {
                        "type": "snapshot",
                        "revision": revision,
                        "conversationState": state,
                    },
                },
                target_client_ids=recipients,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("codex ipc owner publish failed thread={} error={}", thread_id, exc)
            return None
        logger.debug(
            "codex ipc owner snapshot thread={} revision={} followers={}",
            thread_id,
            revision,
            len(recipients),
        )
        return revision

    # -- snapshot ------------------------------------------------------------

    async def build_conversation_state(self, thread_id: str) -> dict[str, Any]:
        read = await self.sdk.read_thread(thread_id=thread_id, include_turns=False)
        try:
            turns_result = await self.sdk.list_thread_turns(thread_id)
            raw_thread = thread_with_raw_turns(read.thread, turns_result.turns)
        except Exception:  # noqa: BLE001 - legacy threads need the full read
            full = await self.sdk.read_thread(thread_id=thread_id, include_turns=True)
            raw_thread = _raw_thread(full.thread)
        session_id = self.session_id_for(thread_id)
        state = self.session_states.get(session_id)
        model, permission = await self._settings_from_selections(state)
        return conversation_state_from_thread(
            raw_thread,
            thread_id=thread_id,
            host_id=self.host_id,
            runtime_status=state.status if state is not None else "idle",
            requests=self._pending_requests(session_id, thread_id),
            active_turn_id=self.active_turn_ids.get(session_id),
            model_settings=model,
            permission_settings=permission,
        )

    async def _settings_from_selections(
        self, state: SessionState | None
    ) -> tuple[CodexModelSettings, CodexPermissionSettings]:
        model = CodexModelSettings()
        permission = CodexPermissionSettings()
        if state is None:
            return model, permission
        try:
            if self.read_model_catalog is not None:
                model = await model_settings_from_selection(
                    state.selections.get("model"), self.read_model_catalog
                )
            if self.read_permission_catalog is not None:
                permission = await permission_settings_from_selection(
                    state.selections.get("permission"), self.read_permission_catalog
                )
        except Exception as exc:  # noqa: BLE001 - stale selection ids
            logger.debug("codex ipc owner selection mapping failed error={}", exc)
        return model, permission

    def _pending_requests(self, session_id: str, thread_id: str) -> list[dict[str, Any]]:
        requests: list[dict[str, Any]] = []
        for notice in self.notices.open_blocking_for_session(session_id):
            source = notice.context.get("approvalSource")
            if not isinstance(source, Mapping):
                continue
            method = source.get("method")
            request_id = source.get("requestId")
            if not isinstance(method, str) or request_id is None:
                continue
            params: dict[str, Any] = {"threadId": thread_id}
            for key in ("itemId", "turnId", "command", "reason", "permissions", "cwd"):
                value = notice.context.get(key) or source.get(key)
                if value is not None:
                    params[key] = value
            requests.append({"method": method, "requestId": request_id, "params": params, "id": request_id})
        return requests

    # -- discovery / follower bookkeeping ------------------------------------

    async def _can_handle_discovery(self, params: Any, request: IpcRequest) -> bool:
        if not isinstance(params, Mapping) or params.get("hostId") != self.host_id:
            return False
        thread_id = params.get("conversationId")
        return isinstance(thread_id, str) and self.owns(thread_id)

    async def _handle_discovery(self, request: IpcRequest) -> Any:
        return {"supportsUntrustedAppInput": False}

    async def _can_handle_follower(self, params: Any, request: IpcRequest) -> bool:
        if not isinstance(params, Mapping):
            return False
        if request.host_id not in (None, self.host_id):
            return False
        thread_id = params.get("conversationId")
        return isinstance(thread_id, str) and self.owns(thread_id)

    async def _on_following_changed(self, broadcast: IpcBroadcast) -> None:
        params = broadcast.params if isinstance(broadcast.params, Mapping) else {}
        thread_id = params.get("conversationId")
        source = broadcast.source_client_id
        if not isinstance(thread_id, str) or not source or params.get("hostId") != self.host_id:
            return
        if not self.owns(thread_id):
            return
        clients = self.followers.setdefault(thread_id, set())
        if params.get("following"):
            clients.add(source)
            await self.publish(thread_id, targets=[source])
        else:
            clients.discard(source)
            if not clients:
                self.followers.pop(thread_id, None)

    async def _on_client_status_changed(self, broadcast: IpcBroadcast) -> None:
        params = broadcast.params if isinstance(broadcast.params, Mapping) else {}
        if params.get("status") != "disconnected":
            return
        client_id = params.get("clientId")
        for thread_id, clients in list(self.followers.items()):
            clients.discard(client_id)
            if not clients:
                self.followers.pop(thread_id, None)

    async def _on_connection_reset(self, broadcast: IpcBroadcast) -> None:
        self.followers.clear()

    # -- follower requests ---------------------------------------------------

    async def _handle_follower(self, request: IpcRequest) -> Any:
        params = request.params if isinstance(request.params, Mapping) else {}
        thread_id = str(params.get("conversationId"))
        session_id = self.session_id_for(thread_id)
        method = request.method
        result: Any
        if method == "thread-follower-start-turn":
            result = {"result": await self._start_turn(thread_id, params)}
        elif method == "thread-follower-steer-turn":
            result = {"result": await self._steer_turn(session_id, thread_id, params)}
        elif method == "thread-follower-interrupt-turn":
            result = await self._interrupt_turn(session_id, thread_id, params)
        elif method in {
            "thread-follower-command-approval-decision",
            "thread-follower-file-approval-decision",
        }:
            await self._respond(params, {"decision": params.get("decision")})
            result = {"ok": True}
        elif method in {
            "thread-follower-permissions-request-approval-response",
            "thread-follower-submit-user-input",
            "thread-follower-submit-mcp-server-elicitation-response",
        }:
            response = params.get("response")
            await self._respond(params, response if isinstance(response, Mapping) else {})
            result = {"ok": True}
        elif method == "thread-follower-load-complete-history":
            revision = await self.publish(thread_id, targets=[request.source_client_id] if request.source_client_id else None)
            if revision is None:
                raise RuntimeError("no-client-found: thread stream owner became unavailable")
            result = {"revision": revision}
        elif method == "thread-follower-read-model-settings":
            result = {"settings": await self._model_settings(thread_id)}
        elif method == "thread-follower-update-thread-settings":
            result = {"applied": await self._update_thread_settings(session_id, thread_id, params)}
        elif method == "thread-follower-compact-thread":
            await self.sdk.compact_thread(thread_id)
            result = {"ok": True}
        elif method in {
            "thread-follower-update-daybreak",
            "thread-follower-set-queued-follow-ups-state",
            "thread-follower-remove-queued-message",
            "thread-follower-clear-queued-messages",
        }:
            result = {"ok": True}
        else:
            raise RuntimeError(f"unsupported follower request {method}")
        self.notify_thread(thread_id)
        return {"method": method, **result}

    async def _start_turn(self, thread_id: str, params: Mapping[str, Any]) -> dict[str, Any]:
        turn_start = params.get("turnStart")
        request = turn_start.get("request") if isinstance(turn_start, Mapping) else None
        request = request if isinstance(request, Mapping) else {}
        text = _input_text(request.get("input"))
        client_message_id = request.get("clientUserMessageId")
        result = await self.sdk.start_turn(
            CodexStartTurnRequest(
                thread_id=thread_id,
                content=text,
                client_message_id=client_message_id if isinstance(client_message_id, str) else None,
                model=_optional_str(request.get("model")),
                effort=_optional_str(request.get("effort")),
                approval_policy=_optional_str(request.get("approvalPolicy")),
                approvals_reviewer=_optional_str(request.get("approvalsReviewer")),
                attachments=_input_attachments(request.get("input")),
            )
        )
        payload = dict(result.payload)
        if "turn" not in payload and result.turn_id:
            payload = {"turn": {"id": result.turn_id, **payload}}
        return payload

    async def _steer_turn(self, session_id: str, thread_id: str, params: Mapping[str, Any]) -> dict[str, Any]:
        turn_id = self.active_turn_ids.get(session_id)
        if turn_id is None:
            raise RuntimeError("no active turn to steer")
        client_message_id = params.get("clientUserMessageId")
        images = _input_attachments(params.get("input"))
        content = _input_text(params.get("input"))
        if images:
            # steer carries text only; reference images by path like the SDK path does.
            content = "\n\n".join([content, *(item.reference_note() for item in images)])
        result = await self.sdk.steer_turn(
            CodexSteerTurnRequest(
                thread_id=thread_id,
                turn_id=turn_id,
                content=content,
                client_message_id=client_message_id if isinstance(client_message_id, str) else None,
            )
        )
        return dict(result.payload)

    async def _interrupt_turn(self, session_id: str, thread_id: str, params: Mapping[str, Any]) -> dict[str, Any]:
        turn_id = self.active_turn_ids.get(session_id)
        expected = params.get("expectedTurnId")
        if turn_id is None:
            return {"interruptedTurnId": expected, "ok": True}
        await self.sdk.interrupt_turn(CodexInterruptTurnRequest(thread_id=thread_id, turn_id=turn_id))
        return {"interruptedTurnId": turn_id, "ok": True}

    async def _respond(self, params: Mapping[str, Any], payload: Mapping[str, Any]) -> None:
        request_id = params.get("requestId")
        if not isinstance(request_id, str | int):
            raise TypeError("requestId is required")
        await self.sdk.respond(request_id, dict(payload))
        await self._resolve_notice(request_id, payload)

    async def _resolve_notice(self, request_id: str | int, payload: Mapping[str, Any]) -> None:
        for thread_id in list(self.followers):
            session_id = self.session_id_for(thread_id)
            for notice in self.notices.open_blocking_for_session(session_id):
                source = notice.context.get("approvalSource")
                if not isinstance(source, Mapping) or source.get("requestId") != request_id:
                    continue
                updated = self.notices.transition(
                    notice.notice_id,
                    status="resolved",
                    response_required=False,
                    blocking=None,
                    actions=(),
                    context={"approvalStatus": "resolved", "responsePayload": dict(payload)},
                    metadata={"source": "codex.ipc.owner/responded"},
                )
                if updated is not None and self.host is not None:
                    await self.host.notice_upsert(updated)

    async def _update_thread_settings(
        self, session_id: str, thread_id: str, params: Mapping[str, Any]
    ) -> bool:
        """Apply a window's thread settings as our next-turn selections."""

        settings = params.get("threadSettings")
        if (
            not isinstance(settings, Mapping)
            or self.apply_selections is None
            or self.read_model_catalog is None
            or self.read_permission_catalog is None
        ):
            return False
        flat: dict[str, Any] = {}
        for key in ("model", "approvalPolicy", "approvalsReviewer", "sandboxPolicy"):
            if settings.get(key) is not None:
                flat[key] = settings[key]
        effort = settings.get("effort")
        if effort is None:
            collaboration = settings.get("collaborationMode")
            inner = collaboration.get("settings") if isinstance(collaboration, Mapping) else None
            effort = inner.get("reasoning_effort") if isinstance(inner, Mapping) else None
        if effort is not None:
            flat["reasoningEffort"] = effort
        selections = await selections_from_thread_state(
            flat, self.read_model_catalog, self.read_permission_catalog
        )
        if not selections:
            return False
        result = await self.apply_selections(session_id, thread_id, selections)
        return bool(getattr(result, "ok", True))

    async def _model_settings(self, thread_id: str) -> dict[str, Any]:
        read = await self.sdk.read_thread(thread_id=thread_id, include_turns=False)
        raw = thread_with_raw_turns(read.thread, ())
        return {
            "model": raw.get("model"),
            "reasoningEffort": raw.get("reasoningEffort") or raw.get("reasoning_effort"),
            "daybreakEnabled": None,
            "resumeState": "resumed",
            "mode": None,
            "threadSource": raw.get("threadSource") or raw.get("thread_source") or "user",
            "modelProvider": raw.get("modelProvider") or raw.get("model_provider"),
        }


# -- conversationState construction -------------------------------------------


def conversation_state_from_thread(
    raw_thread: Mapping[str, Any],
    *,
    thread_id: str,
    host_id: str,
    runtime_status: str,
    requests: list[dict[str, Any]],
    active_turn_id: str | None,
    now: Clock = time.time,
    model_settings: CodexModelSettings | None = None,
    permission_settings: CodexPermissionSettings | None = None,
) -> dict[str, Any]:
    """Build a v11-shaped ``conversationState`` from app-server thread data.

    Field set and defaults mirror the snapshots captured from the Codex desktop
    app and VS Code extension (see docs/codex-ipc-takeover.md §3.5).
    """

    turns = raw_thread.get("turns")
    turns = [turn for turn in turns if isinstance(turn, Mapping)] if isinstance(turns, list) else []
    entities: dict[str, Any] = {}
    entries: list[dict[str, str]] = []
    for index, turn in enumerate(turns):
        turn_id = _first(turn, "id", "turnId", "turn_id") or f"turn-{index}"
        key = f"turn:{turn_id}"
        entities[key] = _turn_entity(turn, thread_id=thread_id, turn_id=str(turn_id), active_turn_id=active_turn_id)
        entries.append({"key": key, "value": key})
    created_ms = _epoch_ms(_first(raw_thread, "createdAt", "created_at"))
    updated_ms = _epoch_ms(_first(raw_thread, "updatedAt", "updated_at"))
    recency_ms = _epoch_ms(_first(raw_thread, "recencyAt", "recency_at")) or updated_ms
    now_ms = int(now() * 1000)
    cwd = _first(raw_thread, "cwd")
    model = (model_settings.model if model_settings else None) or _first(raw_thread, "model")
    effort = (model_settings.effort if model_settings else None) or _first(
        raw_thread, "reasoningEffort", "reasoning_effort"
    )
    permissions = _current_permissions(permission_settings, cwd)
    oldest = entries[0]["key"].removeprefix("turn:") if entries else None
    return {
        "id": thread_id,
        "hostId": host_id,
        "sessionId": _first(raw_thread, "sessionId", "session_id") or thread_id,
        "title": _first(raw_thread, "name", "title"),
        "cwd": cwd,
        "rolloutPath": _first(raw_thread, "path"),
        "originator": _first(raw_thread, "originator"),
        "source": _first(raw_thread, "source") or "cli",
        "threadSource": _first(raw_thread, "threadSource", "thread_source") or "user",
        "threadStartKind": "default",
        "threadRuntimeStatus": _thread_runtime_status(runtime_status),
        "resumeState": "resumed",
        "historyMode": "paginated",
        "requests": requests,
        "turns": [],
        "turnHistory": {
            "kind": "canonical",
            "history": {
                "entitiesByKey": entities,
                "generation": 0,
                "isComplete": True,
                "islands": [
                    {
                        "id": "tail:0",
                        "entries": entries,
                        "olderBoundary": {"status": "exhausted", "boundaryId": "tail:0:older"},
                        "newerBoundary": {"status": "exhausted", "boundaryId": "tail:0:newer"},
                    }
                ],
            },
        },
        "turnsPagination": {
            "olderCursor": None,
            "oldestLoadedTurnId": oldest,
            "isLoadingOlder": False,
            "hasLoadedOldest": True,
        },
        "paginatedHistory": {"itemsBackwardsCursor": None},
        "latestModel": model,
        "latestReasoningEffort": effort,
        "latestCollaborationMode": {
            "mode": "default",
            "settings": {"model": model, "reasoning_effort": effort, "developer_instructions": None},
        },
        "latestThreadSettings": _latest_thread_settings(permissions, cwd, model, effort),
        "latestTokenUsageInfo": None,
        "latestTurnStartMessageId": None,
        "previousTurnModel": None,
        "currentPermissions": permissions,
        "modelProvider": _first(raw_thread, "modelProvider", "model_provider"),
        "mode": "default",
        "createdAt": created_ms or now_ms,
        "updatedAt": updated_ms or now_ms,
        "recencyAt": recency_ms or now_ms,
        "hasUnreadTurn": False,
        "unreadMessageCount": 0,
        "daybreakEnabled": None,
        "gitInfo": _first(raw_thread, "gitInfo", "git_info"),
        "forkedFromId": _first(raw_thread, "forkedFromId", "forked_from_id"),
        "parentThreadId": _first(raw_thread, "parentThreadId", "parent_thread_id"),
        "agentNickname": _first(raw_thread, "agentNickname", "agent_nickname"),
        "environments": [
            {"environmentId": host_id, "cwd": cwd, "runtimeWorkspaceRoots": [cwd] if cwd else []}
        ],
        "environmentSelectionEvidence": {"source": "live", "updatedAt": now_ms / 1000},
        "workspaceKind": "projectless",
        "workspaceBrowserRoot": cwd,
        "projectlessOutputDirectory": None,
        "shellEnvironmentPolicy": None,
        "boundedCloudHistory": None,
        "canonicalVoiceHistory": None,
        "threadGoal": None,
        "threadGoalResumeConfirmation": None,
        "ownerNote": STATE_VERSION_NOTE,
    }


def _turn_entity(
    turn: Mapping[str, Any],
    *,
    thread_id: str,
    turn_id: str,
    active_turn_id: str | None,
) -> dict[str, Any]:
    raw_items = turn.get("items")
    items: list[dict[str, Any]] = []
    if isinstance(raw_items, list):
        for raw in raw_items:
            if isinstance(raw, Mapping):
                items.append(dict(raw))
    status = _turn_status(_first(turn, "status"), turn_id == active_turn_id)
    started_ms = _epoch_ms(_first(turn, "startedAt", "started_at"))
    duration = _first(turn, "durationMs", "duration_ms")
    completed = status != "inProgress"
    user_input = next(
        (item.get("content") for item in items if item.get("type") == "userMessage"),
        None,
    )
    return {
        "params": {
            "threadId": thread_id,
            "input": user_input if isinstance(user_input, list) else [],
            "turnTrigger": "composer",
            "clientUserMessageId": next(
                (item.get("clientId") for item in items if item.get("type") == "userMessage"),
                None,
            ),
        },
        "permissionParamsSource": "inferred",
        "turnId": turn_id,
        "turnStartedAtMs": started_ms,
        "durationMs": duration if isinstance(duration, (int, float)) else None,
        "firstTurnWorkItemStartedAtMs": None,
        "finalAssistantStartedAtMs": None,
        "status": status,
        "error": turn.get("error"),
        "diff": None,
        "items": items,
        "completedItemIds": {
            str(item.get("id")): True for item in items if item.get("id") is not None
        }
        if completed
        else {},
        "itemsPagination": {
            "olderCursor": None,
            "isLoadingOlder": False,
            "hasLoadedOldest": True,
            "newestSnapshotItemId": items[-1].get("id") if items else None,
        },
        "localMetadata": {},
        "requestedReasoningEffort": None,
        "mcpAppModelContextAttachments": [],
        "hookRuns": [],
    }


def _current_permissions(
    settings: CodexPermissionSettings | None, cwd: Any
) -> dict[str, Any] | None:
    if settings is None or (
        settings.approval_policy is None and settings.sandbox is None
    ):
        return None
    sandbox = settings.sandbox or "workspace-write"
    roots = [cwd] if isinstance(cwd, str) and cwd else []
    return permission_block(
        sandbox,
        roots,
        approval_policy=settings.approval_policy,
        approvals_reviewer=settings.approvals_reviewer,
    )


def _latest_thread_settings(
    permissions: Mapping[str, Any] | None,
    cwd: Any,
    model: Any,
    effort: Any,
) -> dict[str, Any] | None:
    if permissions is None and model is None:
        return None
    settings: dict[str, Any] = {
        "disabledPluginIds": [],
        "cwd": cwd,
        "model": model,
        "serviceTier": None,
        "effort": effort,
        "multiAgentMode": "explicitRequestOnly",
        "collaborationMode": {
            "mode": "default",
            "settings": {"model": model, "reasoning_effort": effort, "developer_instructions": None},
        },
    }
    if permissions is not None:
        profile = permissions.get("activePermissionProfile")
        settings.update(
            {
                "approvalPolicy": permissions.get("approvalPolicy"),
                "approvalsReviewer": permissions.get("approvalsReviewer"),
                "activePermissionProfile": profile,
                "sandboxPolicy": permissions.get("sandboxPolicy"),
            }
        )
    return settings


def _raw_thread(thread: Any) -> dict[str, Any]:
    if hasattr(thread, "model_dump"):
        raw = thread.model_dump(mode="json", by_alias=True)
    else:
        raw = dict(thread)
    turns = raw.get("turns")
    raw["turns"] = [dict(turn) for turn in turns if isinstance(turn, Mapping)] if isinstance(turns, list) else []
    return raw


def _thread_runtime_status(runtime_status: str) -> dict[str, Any]:
    if runtime_status in {"running", "pending", "stopping"}:
        return {"type": "active", "activeFlags": []}
    if runtime_status == "waiting":
        return {"type": "active", "activeFlags": ["waitingOnUserInput"]}
    if runtime_status in {"waiting_approval", "blocked"}:
        return {"type": "active", "activeFlags": ["waitingOnApproval"]}
    if runtime_status == "error":
        return {"type": "systemError"}
    return {"type": "idle"}


def _turn_status(raw_status: Any, is_active: bool) -> str:
    if isinstance(raw_status, str) and raw_status:
        mapping = {
            "inProgress": "inProgress",
            "in_progress": "inProgress",
            "completed": "completed",
            "interrupted": "interrupted",
            "failed": "failed",
            "cancelled": "interrupted",
        }
        return mapping.get(raw_status, raw_status)
    return "inProgress" if is_active else "completed"


def _input_text(value: Any) -> str:
    if not isinstance(value, list):
        return ""
    parts: list[str] = []
    for item in value:
        if isinstance(item, Mapping) and item.get("type") == "text":
            text = item.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts)


def _input_attachments(value: Any) -> tuple[CodexTurnInputAttachment, ...]:
    """Turn ``localImage`` inputs from a window into SDK attachments."""

    if not isinstance(value, list):
        return ()
    items: list[CodexTurnInputAttachment] = []
    for item in value:
        if not isinstance(item, Mapping) or item.get("type") != "localImage":
            continue
        path = item.get("path")
        if not isinstance(path, str) or not path:
            continue
        media_type = mimetypes.guess_type(path)[0] or "image/png"
        items.append(
            CodexTurnInputAttachment(
                name=os.path.basename(path),
                path=path,
                media_type=media_type if media_type.startswith("image/") else "image/png",
            )
        )
    return tuple(items)


def _optional_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _first(mapping: Mapping[str, Any], *keys: str) -> Any:
    for key in keys:
        value = mapping.get(key)
        if value is not None:
            return value
    return None


def _epoch_ms(value: Any) -> int | None:
    iso = codex_sessions._utc_iso_time(value)
    if iso is None:
        return None
    from datetime import datetime

    try:
        parsed = datetime.fromisoformat(iso)
    except ValueError:
        return None
    return int(parsed.timestamp() * 1000)


__all__ = [
    "CodexIpcOwnerService",
    "conversation_state_from_thread",
]
