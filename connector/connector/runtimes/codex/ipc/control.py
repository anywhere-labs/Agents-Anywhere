"""Control an IPC-followed thread through its owner window.

Every write goes to the owner as a ``thread-follower-*`` request; the owner
executes the matching app-server call and returns its response. The request
shapes were captured from the Codex desktop app / VS Code extension and
verified live (see ``docs/codex-ipc-takeover.md`` §3.5).
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from connector.logging import logger
from connector.runtime_protocol import (
    RuntimeAttachment,
    RuntimeInvalidRequestError,
    RuntimeOperationResult,
    RuntimeSessionStateCache,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain.approvals import (
    CODEX_COMMAND_APPROVAL_REQUEST,
    CODEX_FILE_CHANGE_APPROVAL_REQUEST,
    CODEX_PERMISSIONS_APPROVAL_REQUEST,
    approval_method_from_context,
    approval_response_from_interaction,
)
from connector.runtimes.codex.domain.input_requests import (
    CODEX_REQUEST_USER_INPUT,
    is_input_request_context,
    user_input_response_from_interaction,
)
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.domain.pending_messages import (
    PendingClientMessageRegistry,
)
from connector.runtimes.codex.domain.selections import (
    ModelCatalogReader,
    PermissionCatalogReader,
    model_settings_from_selection,
    permission_settings_from_selection,
)
from connector.runtimes.codex.ipc.client import (
    CodexIpcClient,
    IpcClientError,
    IpcResponse,
)
from connector.runtimes.codex.ipc.follower import (
    LOCAL_HOST_ID,
    FollowedThread,
    ThreadFollower,
)
from connector.runtimes.codex.ipc.timeline import (
    active_turn_id,
    turn_entities_in_order,
)
from connector.runtimes.codex.sdk.runtime_client import CodexTurnInputAttachment
from connector.runtimes.codex.turns.attachments import materialize_codex_attachments

DEFAULT_REQUEST_TIMEOUT_MS = 30_000
# The App answers thread-follower-start-turn with "...-timeout" when its own
# turn start takes longer than ~5 s, although the turn does start; its state
# stream then shows the new turn.
START_TURN_CONFIRM_TIMEOUT = 20.0
UNKNOWN_OUTCOME_ERRORS = frozenset(
    {"timeout", "request-timeout", "client-disconnected", "server-closed", "connection-closed"}
)
UNKNOWN_OUTCOME_MESSAGE = (
    "Codex App 没有在时限内确认这次发送，消息可能已经开始执行。"
    "AA 不会自动重发；请在会话里确认结果后再决定是否重试。"
)
IPC_SOURCE = "codex.ipc"

_APPROVAL_METHODS: dict[str, str] = {
    CODEX_COMMAND_APPROVAL_REQUEST: "thread-follower-command-approval-decision",
    CODEX_FILE_CHANGE_APPROVAL_REQUEST: "thread-follower-file-approval-decision",
    CODEX_PERMISSIONS_APPROVAL_REQUEST: "thread-follower-permissions-request-approval-response",
    CODEX_REQUEST_USER_INPUT: "thread-follower-submit-user-input",
}


def turn_input(
    text: str,
    attachments: tuple[CodexTurnInputAttachment, ...] = (),
) -> list[dict[str, Any]]:
    """Build app-server ``input`` items: text with file notes, then local images.

    Mirrors the SDK path: images become ``localImage`` inputs (the owner's
    app-server runs on this machine and can read the materialised file), other
    files are referenced by path inside the text.
    """

    notes = [item.reference_note() for item in attachments if not item.is_image]
    full_text = "\n\n".join([text, *notes]) if notes else text
    items: list[dict[str, Any]] = [{"type": "text", "text": full_text, "text_elements": []}]
    for item in attachments:
        if item.is_image:
            items.append({"type": "localImage", "path": item.path})
    return items


def turn_start_request(
    thread_id: str,
    state: Mapping[str, Any],
    text: str,
    client_message_id: str,
    attachments: tuple[CodexTurnInputAttachment, ...] = (),
) -> dict[str, Any]:
    """Mirror the owner's current settings into a ``turn/start`` request."""

    permissions = state.get("currentPermissions")
    permissions = permissions if isinstance(permissions, Mapping) else {}
    collaboration = state.get("latestCollaborationMode")
    return {
        "threadId": thread_id,
        "turnTrigger": "composer",
        "responsesapiClientMetadata": {"source": "codex", "client_type": "extension"},
        "clientUserMessageId": client_message_id,
        "input": turn_input(text, attachments),
        "cwd": state.get("cwd"),
        "model": None,
        "effort": None,
        "multiAgentMode": "explicitRequestOnly",
        "serviceTier": None,
        "collaborationMode": collaboration if isinstance(collaboration, Mapping) else None,
        "approvalPolicy": permissions.get("approvalPolicy"),
        "approvalsReviewer": permissions.get("approvalsReviewer"),
        "sandboxPolicy": permissions.get("sandboxPolicy"),
        "permissions": None,
        "runtimeWorkspaceRoots": None,
        "summary": "none",
        "personality": None,
        "outputSchema": None,
        "attachments": [],
        "commentAttachments": [],
        "useAppServerPermissionDefault": True,
    }


@dataclass(slots=True)
class CodexIpcTurnController:
    client: CodexIpcClient
    follower: ThreadFollower
    host: RuntimeHostClient
    session_states: RuntimeSessionStateCache
    active_turn_ids: dict[str, str]
    notices: CodexNoticeRegistry
    pending_messages: PendingClientMessageRegistry
    request_timeout_ms: int = DEFAULT_REQUEST_TIMEOUT_MS
    read_model_catalog: ModelCatalogReader | None = None
    read_permission_catalog: PermissionCatalogReader | None = None

    # -- routing helpers -----------------------------------------------------

    def attached_thread(self, external_session_id: str | None) -> FollowedThread | None:
        """Return the followed thread when its owner is reachable."""

        if not external_session_id:
            return None
        thread = self.follower.get(external_session_id)
        if (
            thread is None
            or thread.status != "following"
            or thread.owner_client_id is None
            or thread.state is None
        ):
            return None
        return thread

    def ipc_notice_thread(self, notice_id: str) -> FollowedThread | None:
        notice = self.notices.get(notice_id)
        if notice is None or notice.metadata.get("transport") != "ipc":
            return None
        source = notice.context.get("approvalSource")
        thread_id = source.get("threadId") if isinstance(source, Mapping) else None
        if not isinstance(thread_id, str):
            thread_id = notice.context.get("threadId")
        return self.attached_thread(thread_id if isinstance(thread_id, str) else None)

    # -- turns ---------------------------------------------------------------

    async def start_turn(
        self,
        session_id: str,
        thread: FollowedThread,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        """Ask the owner window to start a turn with ``content``.

        Side effects:
        - registers the pending client message for timeline matching
        - updates SessionState to waiting, then running or error
        """

        message_id = client_message_id or str(uuid.uuid4())
        codex_attachments = await materialize_codex_attachments(
            self.host, session_id, attachments
        )
        self.pending_messages.register(
            external_session_id=thread.thread_id,
            client_message_id=client_message_id,
            text=content,
            attachments=attachments,
        )
        await self.session_states.update(
            session_id=session_id,
            external_session_id=thread.thread_id,
            status="waiting",
            metadata={"attachment": "ipc", "source": f"{IPC_SOURCE}.turn/start.requested"},
        )
        params = {
            "conversationId": thread.thread_id,
            "turnStart": {
                "request": turn_start_request(
                    thread.thread_id,
                    thread.state or {},
                    content,
                    message_id,
                    codex_attachments,
                ),
                "context": {"inheritThreadSettings": True},
            },
        }
        known_turns = {key for key, _ in turn_entities_in_order(thread.state or {})}
        response = await self._send(thread, "thread-follower-start-turn", params)
        if response is not None and response.ok:
            turn = _turn_from_result(response.result)
            turn_id = turn.get("id") if isinstance(turn, Mapping) else None
        elif _outcome_unknown(response):
            turn, turn_id = {}, await self._new_turn(thread.thread_id, known_turns)
            logger.info(
                "codex ipc start-turn outcome thread={} error={} confirmed={}",
                thread.thread_id,
                response.error if response is not None else "no-response",
                turn_id is not None,
            )
            if turn_id is None:
                return RuntimeOperationResult(
                    ok=False,
                    code="codex_ipc_start_turn_outcome_unknown",
                    message=UNKNOWN_OUTCOME_MESSAGE,
                    result={"externalSessionId": thread.thread_id, "transport": "ipc"},
                )
        else:
            return await self._failed(
                session_id,
                thread,
                "start",
                response,
                result={"externalSessionId": thread.thread_id},
            )
        if isinstance(turn_id, str) and turn_id:
            self.active_turn_ids[session_id] = turn_id
        await self.session_states.update(
            session_id=session_id,
            external_session_id=thread.thread_id,
            status="running",
            metadata={
                "attachment": "ipc",
                "source": f"{IPC_SOURCE}.turn/start",
                **({"turn_id": turn_id} if isinstance(turn_id, str) else {}),
            },
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "started": True,
                "externalSessionId": thread.thread_id,
                "turnId": turn_id,
                "turn": dict(turn) if isinstance(turn, Mapping) else {},
                "transport": "ipc",
                "attachments": len(codex_attachments),
            },
        )

    async def steer_turn(
        self,
        session_id: str,
        thread: FollowedThread,
        content: str,
        attachments: tuple[RuntimeAttachment, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        turn_id = self.active_turn_ids.get(session_id) or active_turn_id(thread.state or {})
        if turn_id is None:
            return RuntimeOperationResult(
                ok=False,
                code="codex_no_active_turn",
                message="Codex thread has no active turn to steer",
                result={"externalSessionId": thread.thread_id},
            )
        codex_attachments = await materialize_codex_attachments(
            self.host, session_id, attachments
        )
        self.pending_messages.register(
            external_session_id=thread.thread_id,
            client_message_id=client_message_id,
            text=content,
            attachments=attachments,
            steering=True,
            turn_id=turn_id,
        )
        params = {
            "conversationId": thread.thread_id,
            "input": turn_input(content, codex_attachments),
            "clientUserMessageId": client_message_id or str(uuid.uuid4()),
        }
        response = await self._send(thread, "thread-follower-steer-turn", params)
        if response is None or not response.ok:
            return await self._failed(
                session_id,
                thread,
                "steer",
                response,
                result={"steered": False, "turnId": turn_id},
                keep_status=True,
            )
        return RuntimeOperationResult(
            ok=True,
            result={
                "steered": True,
                "turnId": turn_id,
                "externalSessionId": thread.thread_id,
                "turn": _turn_from_result(response.result) or {},
                "transport": "ipc",
            },
        )

    async def interrupt_session(
        self,
        session_id: str,
        thread: FollowedThread,
    ) -> RuntimeOperationResult:
        turn_id = self.active_turn_ids.get(session_id) or active_turn_id(thread.state or {})
        if turn_id is None:
            return RuntimeOperationResult(
                ok=True,
                result={"interrupted": False, "alreadyStopped": True, "transport": "ipc"},
            )
        params: dict[str, Any] = {
            "conversationId": thread.thread_id,
            "mode": "user-stop",
            "expectedTurnId": turn_id,
        }
        response = await self._send(thread, "thread-follower-interrupt-turn", params)
        if response is None or not response.ok:
            return await self._failed(
                session_id,
                thread,
                "interrupt",
                response,
                result={"interrupted": False, "turnId": turn_id},
                keep_status=True,
            )
        result = response.result if isinstance(response.result, Mapping) else {}
        await self.session_states.update(
            session_id=session_id,
            external_session_id=thread.thread_id,
            status="stopping",
            metadata={"attachment": "ipc", "source": f"{IPC_SOURCE}.turn/interrupt", "turn_id": turn_id},
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "interrupted": True,
                "turnId": result.get("interruptedTurnId") or turn_id,
                "externalSessionId": thread.thread_id,
                "transport": "ipc",
            },
        )

    # -- selections ----------------------------------------------------------

    async def update_selections(
        self,
        session_id: str,
        thread: FollowedThread,
        selections: Mapping[str, str | None],
    ) -> RuntimeOperationResult:
        """Push model / permission selections to the owner window.

        The owner applies them to its thread settings for the next turn
        (``thread-follower-update-thread-settings``); the resulting
        ``latestThreadSettings`` patch flows back through the follower and
        updates our cached selections.
        """

        if self.read_model_catalog is None or self.read_permission_catalog is None:
            return RuntimeOperationResult(
                ok=False,
                code="codex_ipc_catalog_unavailable",
                message="Codex catalogs are unavailable for selection mapping",
                result={"externalSessionId": thread.thread_id, "transport": "ipc"},
            )
        try:
            model = await model_settings_from_selection(
                selections.get("model"), self.read_model_catalog
            )
            permission = await permission_settings_from_selection(
                selections.get("permission"), self.read_permission_catalog
            )
        except RuntimeInvalidRequestError as exc:
            return RuntimeOperationResult(
                ok=False,
                code="codex_invalid_selection",
                message=str(exc),
                result={"externalSessionId": thread.thread_id, "selections": dict(selections)},
            )
        thread_settings = thread_settings_with_overrides(
            thread.state or {},
            model=model.model,
            effort=model.effort,
            approval_policy=permission.approval_policy,
            approvals_reviewer=permission.approvals_reviewer,
            sandbox=permission.sandbox,
        )
        params = {
            "conversationId": thread.thread_id,
            "threadSettings": thread_settings,
            "condition": None,
            "activeTurnId": None,
        }
        response = await self._send(thread, "thread-follower-update-thread-settings", params)
        if response is None or not response.ok:
            return RuntimeOperationResult(
                ok=False,
                code=_error_code(response),
                message=_error_message(response),
                result={"externalSessionId": thread.thread_id, "transport": "ipc"},
            )
        result = response.result if isinstance(response.result, Mapping) else {}
        applied = bool(result.get("applied", True))
        cached = self.session_states.get(session_id)
        if applied:
            await self.session_states.update(
                session_id=session_id,
                external_session_id=thread.thread_id,
                status=cached.status if cached is not None else "idle",
                selections={
                    scope: value for scope, value in selections.items() if value is not None
                },
                metadata={"attachment": "ipc", "source": f"{IPC_SOURCE}.selections/updated"},
            )
        return RuntimeOperationResult(
            ok=applied,
            code=None if applied else "codex_ipc_selection_not_applied",
            message=None if applied else "The Codex window did not apply the settings",
            result={
                "externalSessionId": thread.thread_id,
                "selections": dict(selections),
                "applied": applied,
                "transport": "ipc",
            },
        )

    # -- interactions --------------------------------------------------------

    async def respond_interaction(
        self,
        session_id: str,
        thread: FollowedThread,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        """Forward an approval or questionnaire answer to the owner window.

        Side effects:
        - transitions the notice to responding, then resolved or back to open
        - updates SessionState after the answer is accepted
        """

        notice = self.notices.get(notice_id)
        context: dict[str, Any] = dict(notice.context) if notice is not None else {}
        data = dict(input_data or {})
        request_id = data.get("requestId")
        if not isinstance(request_id, str | int):
            source = context.get("approvalSource")
            if isinstance(source, Mapping):
                request_id = source.get("requestId")
        if not isinstance(request_id, str | int):
            raise TypeError("requestId is required to respond to a Codex interaction")
        if is_input_request_context(context):
            method = CODEX_REQUEST_USER_INPUT
            answers = data.get("answers")
            if answers is not None:
                context["answers"] = answers
            payload = user_input_response_from_interaction(action_id, context)
            decision = "cancelled" if payload == {"answers": {}} else "submitted"
            params: dict[str, Any] = {
                "conversationId": thread.thread_id,
                "requestId": request_id,
                "response": dict(payload),
            }
        else:
            method = approval_method_from_context(context) or CODEX_COMMAND_APPROVAL_REQUEST
            approval = approval_response_from_interaction(action_id, context)
            decision = approval.decision
            if method == CODEX_PERMISSIONS_APPROVAL_REQUEST:
                params = {
                    "conversationId": thread.thread_id,
                    "requestId": request_id,
                    "response": dict(approval.payload),
                }
            else:
                params = {
                    "conversationId": thread.thread_id,
                    "requestId": request_id,
                    "decision": approval.payload.get("decision", decision),
                }
        ipc_method = _APPROVAL_METHODS.get(method)
        if ipc_method is None:
            raise TypeError(f"unsupported Codex interaction method {method!r}")
        await self._transition_notice(notice_id, "responding", action_id, decision)
        response = await self._send(thread, ipc_method, params)
        if response is None or not response.ok:
            await self._transition_notice(
                notice_id,
                "open",
                action_id,
                decision,
                failed=response.error if response is not None else "ipc unavailable",
            )
            return RuntimeOperationResult(
                ok=False,
                code=_error_code(response),
                message=_error_message(response),
                result={"noticeId": notice_id, "sessionId": session_id, "transport": "ipc"},
            )
        await self._transition_notice(notice_id, "resolved", action_id, decision)
        next_status = (
            "waiting_approval"
            if self.notices.open_blocking_for_session(session_id)
            else "running"
            if self.active_turn_ids.get(session_id) is not None
            else "idle"
        )
        await self.session_states.update(
            session_id=session_id,
            external_session_id=thread.thread_id,
            status=next_status,
            metadata={
                "attachment": "ipc",
                "source": f"{IPC_SOURCE}.approval/responded",
                "notice_id": notice_id,
                "decision": decision,
            },
        )
        return RuntimeOperationResult(
            ok=True,
            result={
                "resolved": True,
                "noticeId": notice_id,
                "sessionId": session_id,
                "decision": decision,
                "response": dict(params),
                "transport": "ipc",
            },
        )

    # -- helpers -------------------------------------------------------------

    async def _new_turn(self, thread_id: str, known_turns: set[str]) -> str | None:
        """Wait until the owner's state shows a turn started after ``known_turns``."""

        deadline = time.monotonic() + START_TURN_CONFIRM_TIMEOUT
        while time.monotonic() < deadline:
            followed = self.follower.get(thread_id)
            for key, entity in turn_entities_in_order(
                (followed.state if followed is not None else None) or {}
            ):
                turn_id = entity.get("turnId")
                if key not in known_turns and isinstance(turn_id, str) and turn_id:
                    return turn_id
            await asyncio.sleep(0.2)
        return None

    async def _send(
        self,
        thread: FollowedThread,
        method: str,
        params: Mapping[str, Any],
    ) -> IpcResponse | None:
        host_id = None if thread.host_id == LOCAL_HOST_ID else thread.host_id
        try:
            response = await self.client.request(
                method,
                dict(params),
                target_client_id=thread.owner_client_id,
                host_id=host_id,
                timeout_ms=self.request_timeout_ms,
            )
        except IpcClientError as exc:
            logger.warning(
                "codex ipc request failed method={} thread={} error={}",
                method,
                thread.thread_id,
                exc,
            )
            return None
        if not response.ok:
            logger.warning(
                "codex ipc request rejected method={} thread={} error={}",
                method,
                thread.thread_id,
                response.error,
            )
        return response

    async def _failed(
        self,
        session_id: str,
        thread: FollowedThread,
        operation: str,
        response: IpcResponse | None,
        *,
        result: Mapping[str, Any],
        keep_status: bool = False,
    ) -> RuntimeOperationResult:
        code = _error_code(response)
        message = _error_message(response)
        if not keep_status:
            await self.session_states.update(
                session_id=session_id,
                external_session_id=thread.thread_id,
                status="error",
                error={"code": code, "message": message},
                metadata={"attachment": "ipc", "source": f"{IPC_SOURCE}.turn/{operation}.failed"},
            )
        return RuntimeOperationResult(
            ok=False,
            code=code,
            message=message,
            result={**dict(result), "transport": "ipc"},
        )

    async def _transition_notice(
        self,
        notice_id: str,
        status: str,
        action_id: str,
        decision: str,
        *,
        failed: str | None = None,
    ) -> None:
        notice = self.notices.get(notice_id)
        status_key = (
            "inputStatus"
            if notice is not None and is_input_request_context(notice.context)
            else "approvalStatus"
        )
        if status == "resolved":
            updated = self.notices.transition(
                notice_id,
                status="resolved",
                response_required=False,
                blocking=None,
                actions=(),
                context={status_key: "resolved", "responseActionId": action_id, "decision": decision},
                metadata={"attachment": "ipc", "source": f"{IPC_SOURCE}.approval/responded"},
            )
        elif status == "open":
            updated = self.notices.transition(
                notice_id,
                status="open",
                response_required=True,
                context={status_key: "pending", "responseActionId": action_id, "decision": decision},
                metadata={
                    "attachment": "ipc",
                    "source": f"{IPC_SOURCE}.approval/respond_failed",
                    "error": {"message": failed or "unknown"},
                },
            )
        else:
            updated = self.notices.transition(
                notice_id,
                status="responding",
                context={status_key: "responding", "responseActionId": action_id, "decision": decision},
                metadata={"attachment": "ipc", "source": f"{IPC_SOURCE}.approval/responding"},
            )
        if updated is not None:
            await self.host.notice_upsert(updated)


PERMISSION_PROFILE_IDS = {
    "read-only": ":read-only",
    "workspace-write": ":workspace",
    "danger-full-access": ":danger-full-access",
}


def permission_block(
    sandbox: str,
    roots: list[str],
    *,
    approval_policy: str | None,
    approvals_reviewer: str | None,
) -> dict[str, Any]:
    """Build the permission fields exactly like the Codex desktop does.

    Shapes mirror the desktop's ``aM`` / ``iM`` / ``rvt`` helpers: workspace
    write carries ``writableRoots`` (the renderer iterates it; omitting it
    crashes the thread view with "e is not iterable").
    """

    profile = {"id": PERMISSION_PROFILE_IDS.get(sandbox, f":{sandbox}"), "extends": None}
    reviewer = approvals_reviewer or "user"
    if sandbox == "danger-full-access":
        return {
            "activePermissionProfile": profile,
            "runtimeWorkspaceRoots": roots,
            "sandboxPolicy": {"type": "dangerFullAccess"},
            "approvalPolicy": approval_policy or "never",
            "approvalsReviewer": reviewer,
        }
    if sandbox == "read-only":
        return {
            "activePermissionProfile": profile,
            "runtimeWorkspaceRoots": roots,
            "sandboxPolicy": {"type": "readOnly", "networkAccess": False},
            "approvalPolicy": approval_policy or "on-request",
            "approvalsReviewer": reviewer,
        }
    return {
        "activePermissionProfile": profile,
        "runtimeWorkspaceRoots": roots,
        "sandboxPolicy": {
            "type": "workspaceWrite",
            "writableRoots": list(roots),
            "excludeSlashTmp": False,
            "excludeTmpdirEnvVar": False,
            "networkAccess": False,
        },
        "approvalPolicy": approval_policy or "on-request",
        "approvalsReviewer": reviewer,
    }


def workspace_roots(state: Mapping[str, Any]) -> list[str]:
    permissions = state.get("currentPermissions")
    permissions = permissions if isinstance(permissions, Mapping) else {}
    roots = permissions.get("runtimeWorkspaceRoots")
    if isinstance(roots, list) and all(isinstance(root, str) for root in roots) and roots:
        return list(roots)
    cwd = state.get("cwd")
    return [cwd] if isinstance(cwd, str) and cwd else []


def thread_settings_with_overrides(
    state: Mapping[str, Any],
    *,
    model: str | None,
    effort: str | None,
    approval_policy: str | None,
    approvals_reviewer: str | None,
    sandbox: str | None,
) -> dict[str, Any]:
    """Copy the owner's ``latestThreadSettings`` and apply our selections."""

    base = state.get("latestThreadSettings")
    settings: dict[str, Any] = dict(base) if isinstance(base, Mapping) else {}
    settings.setdefault("cwd", state.get("cwd"))
    settings.setdefault("disabledPluginIds", [])
    permissions = state.get("currentPermissions")
    permissions = permissions if isinstance(permissions, Mapping) else {}
    for key in ("approvalPolicy", "approvalsReviewer", "sandboxPolicy", "activePermissionProfile"):
        if key not in settings and permissions.get(key) is not None:
            settings[key] = permissions[key]
    if model is not None:
        settings["model"] = model
        collaboration = settings.get("collaborationMode")
        if isinstance(collaboration, Mapping):
            inner = collaboration.get("settings")
            if isinstance(inner, Mapping):
                settings["collaborationMode"] = {
                    **collaboration,
                    "settings": {**inner, "model": model},
                }
    if effort is not None:
        settings["effort"] = effort
        collaboration = settings.get("collaborationMode")
        if isinstance(collaboration, Mapping):
            inner = collaboration.get("settings")
            if isinstance(inner, Mapping):
                settings["collaborationMode"] = {
                    **collaboration,
                    "settings": {**inner, "reasoning_effort": effort},
                }
    if sandbox is not None:
        # Switching back to workspace write keeps the App's own writable roots,
        # as the App does, instead of deriving them from the cwd.
        existing = _writable_roots(settings.get("sandboxPolicy")) or _writable_roots(
            permissions.get("sandboxPolicy")
        )
        settings.update(
            permission_block(
                sandbox,
                existing if existing is not None else workspace_roots(state),
                approval_policy=approval_policy,
                approvals_reviewer=approvals_reviewer,
            )
        )
        # app-server rejects turns that carry both the legacy ``sandboxPolicy``
        # and the profile-based ``permissions`` field; the desktop sends only
        # the former plus ``activePermissionProfile``.
        settings.pop("permissions", None)
    else:
        if approval_policy is not None:
            settings["approvalPolicy"] = approval_policy
        if approvals_reviewer is not None:
            settings["approvalsReviewer"] = approvals_reviewer
    return settings


def _turn_from_result(result: Any) -> Mapping[str, Any] | None:
    # Owner wraps the app-server response: {"result": {"turn": {...}}}
    if not isinstance(result, Mapping):
        return None
    inner = result.get("result")
    if isinstance(inner, Mapping) and isinstance(inner.get("turn"), Mapping):
        return inner["turn"]
    if isinstance(result.get("turn"), Mapping):
        return result["turn"]
    return None


def _writable_roots(policy: Any) -> list[str] | None:
    if not isinstance(policy, Mapping) or policy.get("type") != "workspaceWrite":
        return None
    roots = policy.get("writableRoots")
    if isinstance(roots, list) and all(isinstance(root, str) for root in roots):
        return list(roots)
    return None


def _outcome_unknown(response: IpcResponse | None) -> bool:
    """Whether the owner may have run the request although no success came back."""

    if response is None:
        return True
    error = response.error or ""
    return error in UNKNOWN_OUTCOME_ERRORS or error.endswith("-timeout")


def _error_code(response: IpcResponse | None) -> str:
    if response is None:
        return "codex_ipc_unavailable"
    error = (response.error or "error").replace("-", "_").replace(" ", "_")
    return f"codex_ipc_{error}"[:80]


def _error_message(response: IpcResponse | None) -> str:
    if response is None:
        return "Codex IPC owner is not reachable"
    return response.error or "Codex IPC request failed"
