from __future__ import annotations

import asyncio
import importlib
from collections.abc import Mapping
from typing import Any

from openai_codex.generated.v2_all import (
    ApprovalsReviewer,
    AskForApproval,
    AskForApprovalValue,
    DangerFullAccessSandboxPolicy,
    ReadOnlySandboxPolicy,
    ReasoningEffort,
    SandboxMode,
    SandboxPolicy,
    ThreadResumeParams,
    ThreadStartParams,
    TurnStartParams,
    WorkspaceWriteSandboxPolicy,
)

from connector.runtime_protocol import RuntimeConfig, RuntimeInvalidRequestError
from connector.runtimes.codex.runtime_helpers import soft_interrupt_failure_reason
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.sdk.runtime_client import (
    CodexCompactResult,
    CodexInterruptTurnRequest,
    CodexModelListResult,
    CodexNotificationMessage,
    CodexRuntimeClient,
    CodexStartThreadRequest,
    CodexStartTurnRequest,
    CodexSteerTurnRequest,
    CodexThreadListResult,
    CodexThreadReadResult,
    CodexThreadResult,
    CodexTurnResult,
    NotificationHandler,
)
from connector.runtimes.codex.sdk.shapes import (
    call_with_optional_handler,
    compact_result,
    id_of,
    maybe_await,
    model_list_result,
    sdk_approval_mode,
    sdk_sandbox,
    thread_list_result,
    thread_read_result,
    thread_ref,
    turn_action_result,
    turn_ref,
)

CodexApprovalSettings = tuple[AskForApproval | None, ApprovalsReviewer | None]


class CodexSdkClient:
    """Adapter from the Codex SDK client shape to the runtime client protocol.

    The connector runtime wants a tiny async JSON-RPC-like surface. Keeping the
    SDK-specific discovery here lets `CodexRuntime` stay protocol-oriented.
    """

    def __init__(self, client: Any, sdk: Any | None = None) -> None:
        self._client = client
        self._sdk = sdk
        self._handler: NotificationHandler | None = None
        self._entered_client: Any | None = None
        self._threads: dict[str, Any] = {}
        self._loaded_thread_ids: set[str] = set()
        self._turns: dict[str, Any] = {}
        self._stream_tasks: dict[str, asyncio.Task[None]] = {}

    async def start(self, handler: NotificationHandler) -> None:
        self._handler = handler
        start = getattr(self._client, "start", None)
        if callable(start):
            await maybe_await(call_with_optional_handler(start, handler))
        elif hasattr(self._client, "__aenter__"):
            self._entered_client = await self._client.__aenter__()

    async def stop(self) -> None:
        for task in self._stream_tasks.values():
            task.cancel()
        if self._stream_tasks:
            await asyncio.gather(*self._stream_tasks.values(), return_exceptions=True)
            self._stream_tasks.clear()
        stop = getattr(self._client, "stop", None)
        if callable(stop):
            await maybe_await(stop())
        elif self._entered_client is not None and hasattr(self._client, "__aexit__"):
            await self._client.__aexit__(None, None, None)
            self._entered_client = None
        elif hasattr(self._client, "close"):
            await maybe_await(self._client.close())

    async def list_models(self) -> CodexModelListResult:
        models = getattr(self._client, "models", None)
        if not callable(models):
            raise RuntimeInvalidRequestError(
                "Codex SDK client does not expose models()"
            )
        result = await models(include_hidden=False)
        return model_list_result(result)

    async def list_threads(
        self,
        limit: int = 100,
        cursor: str | None = None,
    ) -> CodexThreadListResult:
        thread_list = getattr(self._client, "thread_list", None)
        if not callable(thread_list):
            raise RuntimeInvalidRequestError(
                "Codex SDK client does not expose thread_list()"
            )
        result = await thread_list(cursor=cursor, limit=limit)
        return thread_list_result(result)

    async def read_thread(
        self,
        thread_id: str,
        include_turns: bool = True,
    ) -> CodexThreadReadResult:
        thread = self._thread_handle(thread_id)
        result = await thread.read(include_turns=include_turns)
        return thread_read_result(result)

    async def start_thread(self, request: CodexStartThreadRequest) -> CodexThreadResult:
        low_level_client = codex_low_level_client(self._client)
        if low_level_client is not None:
            await ensure_codex_initialized(self._client)
            started = await low_level_client.thread_start(
                codex_thread_start_params(request)
            )
            thread_id = id_of(started.thread)
            thread = codex_async_thread(self._sdk, self._client, thread_id)
            if thread is not None:
                self._remember_thread(thread)
            if thread_id is not None:
                self._loaded_thread_ids.add(thread_id)
            return CodexThreadResult(
                thread_id=thread_id,
                payload={"id": thread_id} if thread_id is not None else {},
            )

        thread_start = getattr(self._client, "thread_start", None)
        if not callable(thread_start):
            raise RuntimeInvalidRequestError(
                "Codex SDK client does not expose thread_start()"
            )
        thread = await thread_start(
            cwd=request.cwd,
            model=request.model,
            approval_mode=sdk_approval_mode(self._sdk, request.approval_policy),
            sandbox=sdk_sandbox(self._sdk, request.sandbox),
            ephemeral=request.ephemeral,
        )
        self._remember_thread(thread)
        thread_id = id_of(thread)
        if thread_id is not None:
            self._loaded_thread_ids.add(thread_id)
        payload = thread_ref(thread)
        return CodexThreadResult(thread_id=thread_id, payload=payload)

    async def start_turn(self, request: CodexStartTurnRequest) -> CodexTurnResult:
        low_level_client = codex_low_level_client(self._client)
        if low_level_client is not None:
            await ensure_codex_initialized(self._client)
            await self.ensure_thread_resumed_for_turn(low_level_client, request)
            started = await self.start_low_level_turn_with_resume_retry(
                low_level_client,
                request,
            )
            turn_id = id_of(started.turn)
            turn = codex_async_turn_handle(
                self._sdk,
                self._client,
                request.thread_id,
                turn_id,
            )
            if turn is not None:
                self._remember_turn(request.thread_id, turn)
            await self._emit(
                {
                    "method": "turn/started",
                    "params": {
                        "threadId": request.thread_id,
                        "turn": {"id": turn_id} if turn_id is not None else {},
                    },
                }
            )
            if turn is not None:
                self._start_stream_task(request.thread_id, turn)
            return CodexTurnResult(
                turn_id=turn_id,
                payload={"id": turn_id} if turn_id is not None else {},
            )

        thread = self._thread_handle(request.thread_id)
        turn = await thread.turn(
            request.content,
            model=request.model,
            effort=request.effort,
            approval_mode=sdk_approval_mode(self._sdk, request.approval_policy),
            sandbox=sdk_sandbox(self._sdk, request.sandbox),
        )
        self._remember_turn(request.thread_id, turn)
        await self._emit(
            {
                "method": "turn/started",
                "params": {
                    "threadId": request.thread_id,
                    "turn": turn_ref(turn),
                },
            }
        )
        self._start_stream_task(request.thread_id, turn)
        payload = turn_ref(turn)
        return CodexTurnResult(turn_id=id_of(turn), payload=payload)

    async def steer_turn(self, request: CodexSteerTurnRequest) -> CodexTurnResult:
        turn = self._turn_handle(
            thread_id=request.thread_id,
            turn_id=request.turn_id,
        )
        result = await turn.steer(request.content)
        payload = turn_action_result(result) or turn_ref(turn)
        return CodexTurnResult(turn_id=id_of(turn), payload=payload)

    async def interrupt_turn(
        self,
        request: CodexInterruptTurnRequest,
    ) -> CodexTurnResult:
        turn = self._turn_handle(
            thread_id=request.thread_id,
            turn_id=request.turn_id,
        )
        result = await turn.interrupt()
        payload = turn_action_result(result) or turn_ref(turn)
        return CodexTurnResult(turn_id=id_of(turn), payload=payload)

    async def compact_thread(self, thread_id: str) -> CodexCompactResult:
        thread = self._thread_handle(thread_id)
        result = await thread.compact()
        return CodexCompactResult(payload=compact_result(result))

    async def ensure_thread_resumed_for_turn(
        self,
        low_level_client: Any,
        request: CodexStartTurnRequest,
    ) -> None:
        """Resume an existing Codex thread before starting a turn.

        Side effects:
        - sends thread/resume to the Codex app-server when this process has not
          loaded the thread yet
        - caches an AsyncThread handle for later thread-scoped operations
        """

        if request.thread_id in self._loaded_thread_ids:
            return
        thread_resume = getattr(low_level_client, "thread_resume", None)
        if not callable(thread_resume):
            return
        resumed = await thread_resume(
            request.thread_id,
            codex_thread_resume_params(request),
        )
        thread_id = id_of(resumed.thread)
        thread = codex_async_thread(self._sdk, self._client, thread_id)
        if thread is not None:
            self._remember_thread(thread)
        if thread_id is not None:
            self._loaded_thread_ids.add(thread_id)

    async def start_low_level_turn_with_resume_retry(
        self,
        low_level_client: Any,
        request: CodexStartTurnRequest,
    ) -> Any:
        """Start a Codex turn, recovering once when the thread was not loaded.

        Side effects:
        - sends turn/start to Codex app-server
        - on thread-not-found, forces thread/resume and retries turn/start once
        """

        try:
            return await low_level_client.turn_start(
                request.thread_id,
                request.content,
                params=codex_turn_start_params(request),
            )
        except Exception as exc:
            if soft_interrupt_failure_reason(str(exc)) != "thread_not_found":
                raise
            self._loaded_thread_ids.discard(request.thread_id)
            await self.force_thread_resume_for_turn(low_level_client, request)
            return await low_level_client.turn_start(
                request.thread_id,
                request.content,
                params=codex_turn_start_params(request),
            )

    async def force_thread_resume_for_turn(
        self,
        low_level_client: Any,
        request: CodexStartTurnRequest,
    ) -> None:
        self._loaded_thread_ids.discard(request.thread_id)
        await self.ensure_thread_resumed_for_turn(low_level_client, request)

    async def respond(
        self,
        request_id: str | int,
        result: Mapping[str, Any] | None = None,
    ) -> None:
        respond = getattr(self._client, "respond", None)
        if not callable(respond):
            raise RuntimeInvalidRequestError(
                "Codex SDK client does not expose respond(request_id, result)"
            )
        await maybe_await(respond(request_id, dict(result or {})))

    def _thread_handle(self, thread_id: str) -> Any:
        cached = self._threads.get(thread_id)
        if cached is not None:
            return cached
        async_thread = (
            getattr(self._sdk, "AsyncThread", None) if self._sdk is not None else None
        )
        if callable(async_thread):
            thread = async_thread(self._client, thread_id)
            self._threads[thread_id] = thread
            return thread
        resume = getattr(self._client, "thread_resume", None)
        if callable(resume):
            raise RuntimeInvalidRequestError(
                "Codex SDK thread handle must be created before use"
            )
        raise RuntimeInvalidRequestError("Codex SDK does not expose AsyncThread")

    def _remember_thread(self, thread: Any) -> None:
        thread_id = id_of(thread)
        if thread_id is not None:
            self._threads[thread_id] = thread

    def _remember_turn(self, thread_id: str, turn: Any) -> None:
        turn_id = id_of(turn)
        if turn_id is not None:
            self._turns[turn_id] = turn
        self._turns[thread_id] = turn

    def _turn_handle(self, thread_id: str, turn_id: str | None) -> Any:
        if turn_id is not None and turn_id in self._turns:
            return self._turns[turn_id]
        turn = self._turns.get(thread_id)
        if turn is None:
            raise RuntimeInvalidRequestError(
                f"Codex SDK has no active turn for thread {thread_id}"
            )
        return turn

    def _start_stream_task(self, thread_id: str, turn: Any) -> None:
        if not callable(getattr(turn, "stream", None)) or self._handler is None:
            return
        turn_id = id_of(turn) or thread_id
        old_task = self._stream_tasks.pop(turn_id, None)
        if old_task is not None:
            old_task.cancel()
        self._stream_tasks[turn_id] = asyncio.create_task(
            self._stream_turn(thread_id, turn_id, turn)
        )

    async def _stream_turn(self, thread_id: str, turn_id: str, turn: Any) -> None:
        completed_seen = False
        cancelled = False
        try:
            async for notification in turn.stream():
                message = CodexSdkEvent.from_value(
                    notification,
                    thread_id=thread_id,
                    turn_id=turn_id,
                )
                if message.event_type in {
                    "turn/completed",
                    "turn/failed",
                    "turn/interrupted",
                    "turn/cancelled",
                }:
                    completed_seen = True
                await self._emit(message)
        except asyncio.CancelledError:
            cancelled = True
            raise
        finally:
            if not completed_seen and not cancelled:
                await self._emit(
                    {
                        "method": "turn/completed",
                        "params": {
                            "threadId": thread_id,
                            "turnId": turn_id,
                            "metadata": {"source": "codex.sdk.stream.finally"},
                        },
                    }
                )
            self._stream_tasks.pop(turn_id, None)
            self._turns.pop(turn_id, None)
            if self._turns.get(thread_id) is turn:
                self._turns.pop(thread_id, None)

    async def _emit(self, message: CodexNotificationMessage) -> None:
        if self._handler is not None:
            await self._handler(message)


def sdk_client_from_config(config: RuntimeConfig) -> CodexRuntimeClient:
    sdk = _load_codex_sdk()
    client = _create_sdk_client(sdk, config)
    return CodexSdkClient(client, sdk=sdk)


def _load_codex_sdk() -> Any:
    for module_name in ("openai_codex", "codex"):
        try:
            return importlib.import_module(module_name)
        except ImportError:
            continue
    raise RuntimeInvalidRequestError("Codex SDK package is not importable")


def _create_sdk_client(sdk: Any, config: RuntimeConfig) -> Any:
    async_codex = getattr(sdk, "AsyncCodex", None)
    if callable(async_codex):
        return async_codex(_sdk_config(sdk, config))
    for factory_name in ("create_runtime_client", "create_client", "Client", "Codex"):
        factory = getattr(sdk, factory_name, None)
        if not callable(factory):
            continue
        try:
            return factory(config=config)
        except TypeError:
            try:
                return factory(config.values)
            except TypeError:
                return factory()
    raise RuntimeInvalidRequestError(
        "Codex SDK does not expose a supported client factory"
    )


def _sdk_config(sdk: Any, config: RuntimeConfig) -> Any:
    config_cls = getattr(sdk, "CodexConfig", None)
    if not callable(config_cls):
        return None
    values = config.values
    environment = values.get("environment")
    return config_cls(
        codex_bin=None,
        env=dict(environment) if isinstance(environment, dict) else None,
        client_name="agents_anywhere_connector",
        client_title="Agents Anywhere Connector",
    )


async def ensure_codex_initialized(client: Any) -> None:
    ensure_initialized = getattr(client, "_ensure_initialized", None)
    if callable(ensure_initialized):
        await maybe_await(ensure_initialized())


def codex_low_level_client(client: Any) -> Any | None:
    candidate = getattr(client, "_client", None)
    if candidate is None:
        return None
    if not callable(getattr(candidate, "thread_start", None)):
        return None
    if not callable(getattr(candidate, "turn_start", None)):
        return None
    return candidate


def codex_thread_start_params(request: CodexStartThreadRequest) -> ThreadStartParams:
    approval_policy, approvals_reviewer = codex_approval_settings(
        request.approval_policy,
        request.approvals_reviewer,
    )
    return ThreadStartParams(
        approvalPolicy=approval_policy,
        approvalsReviewer=approvals_reviewer,
        cwd=request.cwd,
        ephemeral=request.ephemeral,
        model=request.model,
        sandbox=codex_thread_sandbox_mode(request.sandbox),
    )


def codex_thread_resume_params(request: CodexStartTurnRequest) -> ThreadResumeParams:
    approval_policy, approvals_reviewer = codex_approval_settings(
        request.approval_policy,
        request.approvals_reviewer,
    )
    return ThreadResumeParams(
        approvalPolicy=approval_policy,
        approvalsReviewer=approvals_reviewer,
        model=request.model,
        sandbox=codex_thread_sandbox_mode(request.sandbox),
        threadId=request.thread_id,
    )


def codex_turn_start_params(request: CodexStartTurnRequest) -> TurnStartParams:
    approval_policy, approvals_reviewer = codex_approval_settings(
        request.approval_policy,
        request.approvals_reviewer,
    )
    return TurnStartParams(
        approvalPolicy=approval_policy,
        approvalsReviewer=approvals_reviewer,
        clientUserMessageId=request.client_message_id,
        effort=codex_reasoning_effort(request.effort),
        input=[],
        model=request.model,
        sandboxPolicy=codex_turn_sandbox_policy(request.sandbox),
        threadId=request.thread_id,
    )


def codex_approval_settings(
    approval_policy: str | None,
    approvals_reviewer: str | None = None,
) -> CodexApprovalSettings:
    if approval_policy in {"request_approval", "untrusted", "ask_untrusted"}:
        return AskForApproval(
            root=AskForApprovalValue.untrusted
        ), ApprovalsReviewer.user
    if approval_policy in {"on-request", "on_request"}:
        return (
            AskForApproval(root=AskForApprovalValue.on_request),
            codex_approvals_reviewer(approvals_reviewer),
        )
    if approval_policy in {"auto_review", "auto-review"}:
        return (
            AskForApproval(root=AskForApprovalValue.on_request),
            ApprovalsReviewer.auto_review,
        )
    if approval_policy in {"full_access", "never", "deny_all", "deny-all"}:
        return AskForApproval(root=AskForApprovalValue.never), None
    return None, None


def codex_approvals_reviewer(value: str | None) -> ApprovalsReviewer | None:
    if value in {"user", "request_approval"}:
        return ApprovalsReviewer.user
    if value in {"auto_review", "auto-review"}:
        return ApprovalsReviewer.auto_review
    if value in {"guardian_subagent", "guardian-subagent"}:
        return ApprovalsReviewer.guardian_subagent
    return None


def codex_thread_sandbox_mode(value: str | None) -> SandboxMode | None:
    if value in {"read-only", "read_only"}:
        return SandboxMode.read_only
    if value in {"workspace-write", "workspace_write"}:
        return SandboxMode.workspace_write
    if value in {"danger-full-access", "full-access", "full_access"}:
        return SandboxMode.danger_full_access
    return None


def codex_turn_sandbox_policy(value: str | None) -> SandboxPolicy | None:
    if value in {"read-only", "read_only"}:
        return SandboxPolicy(root=ReadOnlySandboxPolicy(type="readOnly"))
    if value in {"workspace-write", "workspace_write"}:
        return SandboxPolicy(root=WorkspaceWriteSandboxPolicy(type="workspaceWrite"))
    if value in {"danger-full-access", "full-access", "full_access"}:
        return SandboxPolicy(
            root=DangerFullAccessSandboxPolicy(type="dangerFullAccess")
        )
    return None


def codex_reasoning_effort(value: str | None) -> ReasoningEffort | None:
    if value == "none":
        return ReasoningEffort.none
    if value == "minimal":
        return ReasoningEffort.minimal
    if value == "low":
        return ReasoningEffort.low
    if value == "medium":
        return ReasoningEffort.medium
    if value == "high":
        return ReasoningEffort.high
    if value == "xhigh":
        return ReasoningEffort.xhigh
    return None


def codex_async_thread(
    sdk: Any | None, client: Any, thread_id: str | None
) -> Any | None:
    if thread_id is None:
        return None
    async_thread = getattr(sdk, "AsyncThread", None) if sdk is not None else None
    if not callable(async_thread):
        return None
    return async_thread(client, thread_id)


def codex_async_turn_handle(
    sdk: Any | None,
    client: Any,
    thread_id: str,
    turn_id: str | None,
) -> Any | None:
    if turn_id is None:
        return None
    async_turn_handle = (
        getattr(sdk, "AsyncTurnHandle", None) if sdk is not None else None
    )
    if not callable(async_turn_handle):
        return None
    return async_turn_handle(client, thread_id, turn_id)
