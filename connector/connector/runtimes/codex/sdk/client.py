from __future__ import annotations

import asyncio
import importlib
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import RuntimeConfig, RuntimeInvalidRequestError
from connector.runtimes.codex.sdk.events import CodexSdkEvent
from connector.runtimes.codex.sdk.runtime_client import (
    CodexCompactResult,
    CodexInterruptTurnRequest,
    CodexNotificationMessage,
    CodexRuntimeClient,
    CodexStartThreadRequest,
    CodexStartTurnRequest,
    CodexSteerTurnRequest,
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

    async def list_models(self) -> dict[str, Any]:
        models = getattr(self._client, "models", None)
        if not callable(models):
            raise RuntimeInvalidRequestError("Codex SDK client does not expose models()")
        result = await models(include_hidden=False)
        return model_list_result(result)

    async def list_threads(
        self,
        limit: int = 100,
        cursor: str | None = None,
    ) -> dict[str, Any]:
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
    ) -> dict[str, Any]:
        thread = self._thread_handle(thread_id)
        result = await thread.read(include_turns=include_turns)
        return thread_read_result(result)

    async def start_thread(self, request: CodexStartThreadRequest) -> CodexThreadResult:
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
        payload = thread_ref(thread)
        return CodexThreadResult(thread_id=id_of(thread), payload=payload)

    async def start_turn(self, request: CodexStartTurnRequest) -> CodexTurnResult:
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
