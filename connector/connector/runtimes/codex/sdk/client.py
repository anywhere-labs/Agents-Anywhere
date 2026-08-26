from __future__ import annotations

import asyncio
import hashlib
import importlib
import time
from collections.abc import Mapping
from typing import Any

from openai_codex import MethodNotFoundError
from openai_codex.generated.v2_all import (
    ApprovalsReviewer,
    AskForApproval,
    AskForApprovalValue,
    DangerFullAccessSandboxPolicy,
    LocalImageUserInput,
    ReadOnlySandboxPolicy,
    ReasoningEffort,
    SandboxMode,
    SandboxPolicy,
    TextUserInput,
    ThreadResumeParams,
    ThreadStartParams,
    Turn,
    TurnStartParams,
    UserInput,
    WorkspaceWriteSandboxPolicy,
)
from pydantic import BaseModel, ConfigDict, Field

from connector.logging import logger
from connector.runtime_protocol import RuntimeConfig, RuntimeInvalidRequestError
from connector.runtimes.codex.runtime_helpers import soft_codex_unavailable_reason
from connector.runtimes.codex.sdk.binary import (
    codex_runtime_environment,
    select_codex_runtime_binary,
)
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.sdk.model_gateway import (
    CODEX_MODEL_GATEWAY_PROVIDER_ID,
    codex_model_gateway_config,
)
from connector.runtimes.codex.sdk.server_requests import (
    install_deferred_server_request_reader,
)
from connector.runtimes.codex.sdk.runtime_client import (
    CodexCompactResult,
    CodexInterruptTurnRequest,
    CodexModelListResult,
    CodexNotificationMessage,
    CodexResumeThreadRequest,
    CodexRuntimeClient,
    CodexStartThreadRequest,
    CodexStartTurnRequest,
    CodexSteerTurnRequest,
    CodexThreadListResult,
    CodexThreadReadResult,
    CodexThreadResult,
    CodexThreadTurnsResult,
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
from connector.runtimes.model_gateway import ModelGateway, model_gateway_from_config

CodexApprovalSettings = tuple[AskForApproval | None, ApprovalsReviewer | None]
CODEX_SDK_APPROVAL_REQUEST_METHODS = {
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "item/permissions/requestApproval",
}
CODEX_THREAD_TURNS_PAGE_SIZE = 100


class CodexThreadTurnsListResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    data: list[Turn]
    next_cursor: str | None = Field(default=None, alias="nextCursor")


class CodexSdkClient:
    """Adapter from the Codex SDK client shape to the runtime client protocol.

    The connector runtime wants a tiny async JSON-RPC-like surface. Keeping the
    SDK-specific discovery here lets `CodexRuntime` stay protocol-oriented.
    """

    def __init__(
        self,
        client: Any,
        sdk: Any | None = None,
        model_gateway: ModelGateway | None = None,
    ) -> None:
        self._client = client
        self._sdk = sdk
        self._model_gateway = model_gateway
        self._handler: NotificationHandler | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._pending_approval_responses: dict[
            str, asyncio.Future[Mapping[str, Any]]
        ] = {}
        self._entered_client: Any | None = None
        self._threads: dict[str, Any] = {}
        self._loaded_thread_ids: set[str] = set()
        self._turns: dict[str, Any] = {}
        self._stream_tasks: dict[str, asyncio.Task[None]] = {}
        self._global_notification_task: asyncio.Task[None] | None = None

    async def start(self, handler: NotificationHandler) -> None:
        self._handler = handler
        self._loop = asyncio.get_running_loop()
        if install_deferred_server_request_reader(self._client):
            logger.debug("codex sdk deferred server request reader installed")
        install_codex_approval_handler(self._client, self.handle_sdk_approval_request)
        start = getattr(self._client, "start", None)
        if callable(start):
            await maybe_await(call_with_optional_handler(start, handler))
        elif hasattr(self._client, "__aenter__"):
            self._entered_client = await self._client.__aenter__()
        self.start_global_notification_task()

    async def stop(self) -> None:
        self.cancel_pending_approval_responses()
        if self._global_notification_task is not None:
            self._global_notification_task.cancel()
            await asyncio.gather(
                self._global_notification_task,
                return_exceptions=True,
            )
            self._global_notification_task = None
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

    def cancel_pending_approval_responses(self) -> None:
        pending = tuple(self._pending_approval_responses.values())
        self._pending_approval_responses.clear()
        for response in pending:
            if not response.done():
                response.set_result({"decision": "decline"})

    def start_global_notification_task(self) -> None:
        """Forward SDK global notifications to the runtime projector.

        Side effects:
        - starts one background task owned by this client
        - emits non-turn-scoped SDK notifications such as thread/compacted
        """

        next_notification = getattr(self._client, "next_notification", None)
        if not callable(next_notification) or self._handler is None:
            return
        if self._global_notification_task is not None:
            return
        self._global_notification_task = asyncio.create_task(
            self.stream_global_notifications(next_notification)
        )
        self._global_notification_task.add_done_callback(
            self.handle_global_notification_task_done
        )

    def handle_global_notification_task_done(self, task: asyncio.Task[None]) -> None:
        if self._global_notification_task is task:
            self._global_notification_task = None
        try:
            task.result()
        except asyncio.CancelledError:
            logger.debug("codex sdk global notification task cancelled")
        except Exception:  # noqa: BLE001
            logger.exception("codex sdk global notification task failed")

    async def stream_global_notifications(self, next_notification: Any) -> None:
        while True:
            notification = await maybe_await(next_notification())
            await self._emit(notification)

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
        started_at = time.monotonic()
        thread = self._thread_handle(thread_id)
        result = await thread.read(include_turns=include_turns)
        projected = thread_read_result(result)
        elapsed_ms = (time.monotonic() - started_at) * 1000
        if include_turns or elapsed_ms >= 250:
            logger.info(
                "codex sdk thread read completed thread_id={} include_turns={} elapsed_ms={:.1f}",
                thread_id,
                include_turns,
                elapsed_ms,
            )
        return projected

    async def list_thread_turns(self, thread_id: str) -> CodexThreadTurnsResult:
        await ensure_codex_initialized(self._client)
        low_level_client = getattr(self._client, "_client", None)
        request = getattr(low_level_client, "request", None)
        if not callable(request):
            raise RuntimeInvalidRequestError(
                "Codex SDK client does not expose raw request() for thread turns"
            )
        turns_descending: list[Turn] = []
        cursor: str | None = None
        seen_cursors: set[str] = set()
        while True:
            params: dict[str, Any] = {
                "threadId": thread_id,
                "limit": CODEX_THREAD_TURNS_PAGE_SIZE,
                "sortDirection": "desc",
                "itemsView": "full",
            }
            if cursor is not None:
                params["cursor"] = cursor
            try:
                page = await request(
                    "thread/turns/list",
                    params,
                    response_model=CodexThreadTurnsListResponse,
                )
            except MethodNotFoundError as exc:
                raise RuntimeInvalidRequestError(
                    "Codex app-server does not support thread/turns/list"
                ) from exc
            turns_descending.extend(page.data)
            next_cursor = page.next_cursor
            if next_cursor is None or next_cursor in seen_cursors:
                break
            seen_cursors.add(next_cursor)
            cursor = next_cursor
        turns_descending.reverse()
        return CodexThreadTurnsResult(turns=tuple(turns_descending))

    async def start_thread(self, request: CodexStartThreadRequest) -> CodexThreadResult:
        await ensure_codex_initialized(self._client)
        low_level_client = codex_low_level_client(self._client)
        if low_level_client is not None:
            started = await low_level_client.thread_start(
                codex_thread_start_params(request, self._model_gateway)
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
        if self._model_gateway is not None:
            raise RuntimeInvalidRequestError(
                "Codex low-level client is required for model gateway configuration"
            )
        if codex_request_requires_low_level_approval(request):
            raise RuntimeInvalidRequestError(
                "Codex low-level client is required for explicit approval settings"
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
        await ensure_codex_initialized(self._client)
        low_level_client = codex_low_level_client(self._client)
        if low_level_client is not None:
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
        if codex_request_requires_low_level_turn_start(request):
            raise RuntimeInvalidRequestError(
                codex_low_level_turn_start_required_message(request)
            )

        thread = self._thread_handle(request.thread_id)
        turn = await thread.turn(
            codex_high_level_turn_content(request),
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
        await ensure_codex_initialized(self._client)
        low_level_client = codex_low_level_client(self._client)
        if low_level_client is not None:
            await self.ensure_thread_resumed(
                low_level_client,
                CodexResumeThreadRequest(thread_id=thread_id),
            )
        thread = self._thread_handle(thread_id)
        result = await thread.compact()
        return CodexCompactResult(payload=compact_result(result))

    async def ensure_thread_resumed(
        self,
        low_level_client: Any,
        request: CodexResumeThreadRequest,
    ) -> None:
        """Resume an existing Codex thread before a thread-scoped operation.

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
            codex_thread_resume_params(request, self._model_gateway),
        )
        thread_id = id_of(resumed.thread)
        thread = codex_async_thread(self._sdk, self._client, thread_id)
        if thread is not None:
            self._remember_thread(thread)
        if thread_id is not None:
            self._loaded_thread_ids.add(thread_id)

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

        await self.ensure_thread_resumed(
            low_level_client,
            CodexResumeThreadRequest(
                thread_id=request.thread_id,
                model=request.model,
                approval_policy=request.approval_policy,
                approvals_reviewer=request.approvals_reviewer,
                sandbox=request.sandbox,
            ),
        )

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
                codex_turn_user_input_wire(request),
                params=codex_turn_start_params(request),
            )
        except Exception as exc:
            if soft_codex_unavailable_reason(str(exc)) != "thread_not_found":
                raise
            self._loaded_thread_ids.discard(request.thread_id)
            await self.force_thread_resume_for_turn(low_level_client, request)
            return await low_level_client.turn_start(
                request.thread_id,
                codex_turn_user_input_wire(request),
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
        response_payload = dict(result or {})
        request_key = str(request_id)
        approval_response = self._pending_approval_responses.pop(request_key, None)
        if approval_response is not None:
            if not approval_response.done():
                approval_response.set_result(response_payload)
            logger.info(
                "codex sdk approval response delivered request_id={} pending_hit=true payload_keys={}",
                request_key,
                sorted(response_payload.keys()),
            )
            return
        logger.warning(
            "codex sdk approval response has no pending request request_id={} pending_ids={} payload_keys={}",
            request_key,
            sorted(self._pending_approval_responses.keys()),
            sorted(response_payload.keys()),
        )
        respond = getattr(self._client, "respond", None)
        if not callable(respond):
            raise RuntimeInvalidRequestError(
                "Codex SDK client does not expose respond(request_id, result)"
            )
        await maybe_await(respond(request_id, response_payload))

    def handle_sdk_approval_request(
        self,
        method: str,
        params: Mapping[str, Any] | None,
    ) -> dict[str, Any]:
        if method not in CODEX_SDK_APPROVAL_REQUEST_METHODS:
            return {}
        loop = self._loop
        if loop is None:
            logger.warning(
                "codex sdk approval request declined because runtime loop is unavailable method={}",
                method,
            )
            return {"decision": "decline"}
        started_at = time.monotonic()
        future = asyncio.run_coroutine_threadsafe(
            self.publish_sdk_approval_request(method, dict(params or {})),
            loop,
        )
        response = dict(future.result())
        elapsed_ms = (time.monotonic() - started_at) * 1000
        logger.info(
            "codex sdk approval request completed method={} elapsed_ms={:.1f} response_keys={}",
            method,
            elapsed_ms,
            sorted(response.keys()),
        )
        return response

    async def publish_sdk_approval_request(
        self,
        method: str,
        params: dict[str, Any],
    ) -> Mapping[str, Any]:
        if self._handler is None:
            logger.warning(
                "codex sdk approval request declined because notification handler is unavailable method={}",
                method,
            )
            return {"decision": "decline"}
        request_id = sdk_approval_request_id(method, params)
        response: asyncio.Future[Mapping[str, Any]] = asyncio.Future()
        self._pending_approval_responses[request_id] = response
        logger.info(
            "codex sdk approval request registered method={} request_id={} approval_id={} thread_id={} turn_id={} item_id={}",
            method,
            request_id,
            approval_identifier(params),
            params.get("threadId") or params.get("thread_id"),
            params.get("turnId") or params.get("turn_id"),
            params.get("itemId") or params.get("item_id"),
        )
        try:
            await self._handler(
                {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "method": method,
                    "params": params,
                }
            )
            return await response
        finally:
            self._pending_approval_responses.pop(request_id, None)
            logger.debug(
                "codex sdk approval request unregistered request_id={} pending_count={}",
                request_id,
                len(self._pending_approval_responses),
            )

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
                        "method": "turn/failed",
                        "params": {
                            "threadId": thread_id,
                            "turnId": turn_id,
                            "error": {
                                "code": "codex_stream_ended_without_terminal_event",
                                "message": "Codex stream ended without a terminal turn event.",
                            },
                            "metadata": {"source": "codex.sdk.stream.exhausted"},
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
    model_gateway = model_gateway_from_config(config.values.get("modelGateway"))
    return CodexSdkClient(
        client,
        sdk=sdk,
        model_gateway=model_gateway,
    )


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
    environment_overrides = values.get("environment")
    use_system_codex = values.get("useSystemCodex", True)
    mode = "prefer_system" if use_system_codex is True else "sdk_bundled"
    environment = (
        environment_overrides if isinstance(environment_overrides, Mapping) else None
    )
    codex_home = values.get("codexHome")
    if isinstance(codex_home, str):
        runtime_environment, shell_path = codex_runtime_environment(
            environment,
            codex_home=codex_home,
        )
    else:
        runtime_environment, shell_path = codex_runtime_environment(environment)
    binary_selection = select_codex_runtime_binary(
        mode,
        runtime_environment,
        shell_path,
        configured_path=(
            values.get("codexExecutablePath")
            if isinstance(values.get("codexExecutablePath"), str)
            else None
        ),
    )
    logger.info(
        "codex sdk runtime binary selected mode={} source={} codex_bin={} login_shell={}",
        binary_selection.mode,
        binary_selection.source,
        binary_selection.codex_bin,
        binary_selection.login_shell,
    )
    return config_cls(
        codex_bin=binary_selection.codex_bin,
        env=runtime_environment,
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


def install_codex_approval_handler(client: Any, handler: Any) -> bool:
    nested_client = getattr(client, "_client", None)
    sync_client = getattr(nested_client, "_sync", None)
    if sync_client is not None and hasattr(sync_client, "_approval_handler"):
        sync_client._approval_handler = handler
        return True
    if hasattr(client, "_approval_handler"):
        client._approval_handler = handler
        return True
    return False


def sdk_approval_request_id(method: str, params: Mapping[str, Any]) -> str:
    for key in ("approvalId", "approval_id", "requestId", "request_id"):
        value = params.get(key)
        if isinstance(value, str | int) and str(value):
            return f"approval_{value}"
    stable_parts = [
        method,
        str(params.get("threadId") or params.get("thread_id") or ""),
        str(params.get("turnId") or params.get("turn_id") or ""),
        str(params.get("itemId") or params.get("item_id") or ""),
        str(params.get("command") or params.get("cmd") or ""),
    ]
    digest = hashlib.sha256(":".join(stable_parts).encode()).hexdigest()[:24]
    return f"approval_{digest}"


def approval_identifier(params: Mapping[str, Any]) -> str | int | None:
    for key in ("approvalId", "approval_id", "requestId", "request_id"):
        value = params.get(key)
        if isinstance(value, str | int) and str(value):
            return value
    return None


def codex_request_requires_low_level_turn_start(
    request: CodexStartTurnRequest,
) -> bool:
    return (
        request.approval_policy is not None
        or request.approvals_reviewer is not None
        or len(request.attachments) > 0
    )


def codex_request_requires_low_level_approval(
    request: CodexStartThreadRequest | CodexStartTurnRequest,
) -> bool:
    return request.approval_policy is not None or request.approvals_reviewer is not None


def codex_low_level_turn_start_required_message(
    request: CodexStartTurnRequest,
) -> str:
    if request.attachments:
        return "Codex low-level client is required for typed attachment input"
    return "Codex low-level client is required for explicit approval settings"


def codex_thread_start_params(
    request: CodexStartThreadRequest,
    model_gateway: ModelGateway | None = None,
) -> ThreadStartParams:
    approval_policy, approvals_reviewer = codex_approval_settings(
        request.approval_policy,
        request.approvals_reviewer,
    )
    return ThreadStartParams(
        approvalPolicy=approval_policy,
        approvalsReviewer=approvals_reviewer,
        cwd=request.cwd,
        ephemeral=request.ephemeral,
        config=(
            codex_model_gateway_config(model_gateway)
            if model_gateway is not None
            else None
        ),
        model=request.model,
        modelProvider=(
            CODEX_MODEL_GATEWAY_PROVIDER_ID if model_gateway is not None else None
        ),
        sandbox=codex_thread_sandbox_mode(request.sandbox),
    )


def codex_thread_resume_params(
    request: CodexResumeThreadRequest | CodexStartTurnRequest,
    model_gateway: ModelGateway | None = None,
) -> ThreadResumeParams:
    approval_policy, approvals_reviewer = codex_approval_settings(
        request.approval_policy,
        request.approvals_reviewer,
    )
    return ThreadResumeParams(
        approvalPolicy=approval_policy,
        approvalsReviewer=approvals_reviewer,
        config=(
            codex_model_gateway_config(model_gateway)
            if model_gateway is not None
            else None
        ),
        model=request.model,
        modelProvider=(
            CODEX_MODEL_GATEWAY_PROVIDER_ID if model_gateway is not None else None
        ),
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
        input=codex_turn_user_input(request),
        model=request.model,
        sandboxPolicy=codex_turn_sandbox_policy(request.sandbox),
        threadId=request.thread_id,
    )


def codex_turn_user_input(request: CodexStartTurnRequest) -> list[UserInput]:
    values: list[UserInput] = [
        UserInput(
            root=TextUserInput(
                text=codex_turn_text_input(request),
                type="text",
            )
        )
    ]
    for attachment in request.attachments:
        if attachment.is_image:
            values.append(
                UserInput(
                    root=LocalImageUserInput(
                        path=attachment.path,
                        type="localImage",
                    )
                )
            )
            continue
    return values


def codex_turn_text_input(request: CodexStartTurnRequest) -> str:
    notes = [
        attachment.reference_note()
        for attachment in request.attachments
        if not attachment.is_image
    ]
    if not notes:
        return request.content
    return "\n\n".join([request.content, *notes])


def codex_turn_user_input_wire(request: CodexStartTurnRequest) -> list[dict[str, Any]]:
    return [
        item.model_dump(
            by_alias=True,
            exclude_defaults=True,
            exclude_none=True,
            mode="json",
        )
        for item in codex_turn_user_input(request)
    ]


def codex_high_level_turn_content(request: CodexStartTurnRequest) -> str:
    if not request.attachments:
        return request.content
    return "\n\n".join([request.content, codex_attachment_input_note(request)])


def codex_attachment_input_note(request: CodexStartTurnRequest) -> str:
    lines = [
        attachment.reference_note()
        for attachment in request.attachments
        if not attachment.is_image
    ]
    return "\n".join(lines)


def codex_approval_settings(
    approval_policy: str | None,
    approvals_reviewer: str | None = None,
) -> CodexApprovalSettings:
    if approval_policy in {"request_approval", "on-request", "on_request"}:
        return (
            AskForApproval(root=AskForApprovalValue.on_request),
            codex_approvals_reviewer(approvals_reviewer) or ApprovalsReviewer.user,
        )
    if approval_policy in {"untrusted", "ask_untrusted"}:
        return AskForApproval(
            root=AskForApprovalValue.untrusted
        ), ApprovalsReviewer.user
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
