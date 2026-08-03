from __future__ import annotations

import asyncio
import importlib
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import RuntimeConfig, RuntimeInvalidRequestError
from connector.runtimes.codex.runtime_client import (
    CodexRuntimeClient,
    NotificationHandler,
)
from connector.runtimes.codex.sdk_shapes import (
    call_with_optional_handler,
    dump_sdk_result,
    id_of,
    maybe_await,
    notification_dict,
    optional_int,
    optional_string,
    required_thread_id,
    run_input,
    sdk_approval_mode,
    sdk_sandbox,
    thread_ref,
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

    async def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        routed = await self._request_sdk_method(method, dict(params or {}))
        if routed is not None:
            return routed
        request = getattr(self._client, "request", None)
        if not callable(request):
            raise RuntimeInvalidRequestError(
                f"Codex SDK client does not expose request(method, params) for {method}"
            )
        result = await maybe_await(request(method, dict(params or {})))
        return result if isinstance(result, dict) else {}

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

    async def _request_sdk_method(
        self,
        method: str,
        params: dict[str, Any],
    ) -> dict[str, Any] | None:
        if method == "initialize":
            return {}
        if method == "model/list" and callable(getattr(self._client, "models", None)):
            result = await self._client.models(
                include_hidden=bool(params.get("includeHidden") or params.get("include_hidden"))
            )
            return dump_sdk_result(result)
        if method == "thread/list" and callable(
            getattr(self._client, "thread_list", None)
        ):
            result = await self._client.thread_list(
                cursor=optional_string(params.get("cursor")),
                limit=optional_int(params.get("limit")),
            )
            return dump_sdk_result(result)
        if method == "thread/read":
            thread_id = required_thread_id(params)
            thread = self._thread_handle(thread_id)
            result = await thread.read(
                include_turns=bool(params.get("includeTurns") or params.get("include_turns"))
            )
            return dump_sdk_result(result)
        if method == "thread/start" and callable(
            getattr(self._client, "thread_start", None)
        ):
            thread = await self._client.thread_start(
                cwd=optional_string(params.get("cwd")),
                model=optional_string(params.get("model")),
                approval_mode=sdk_approval_mode(self._sdk, params.get("approvalPolicy")),
                sandbox=sdk_sandbox(self._sdk, params.get("sandbox")),
                ephemeral=bool(params.get("ephemeral")) if "ephemeral" in params else None,
            )
            self._remember_thread(thread)
            return {"thread": thread_ref(thread)}
        if method == "thread/update":
            thread = self._thread_handle(required_thread_id(params))
            result = await self._update_thread_settings(thread, params)
            return dump_sdk_result(result) or {"thread": thread_ref(thread)}
        if method == "turn/start":
            thread_id = required_thread_id(params)
            thread = self._thread_handle(thread_id)
            turn = await thread.turn(
                run_input(params),
                model=optional_string(params.get("model")),
                effort=optional_string(params.get("effort")),
                approval_mode=sdk_approval_mode(self._sdk, params.get("approvalPolicy")),
                sandbox=sdk_sandbox(self._sdk, params.get("sandbox")),
            )
            self._remember_turn(thread_id, turn)
            await self._emit(
                {
                    "method": "turn/started",
                    "params": {
                        "threadId": thread_id,
                        "turn": turn_ref(turn),
                    },
                }
            )
            self._start_stream_task(thread_id, turn)
            return {"turn": turn_ref(turn)}
        if method == "turn/steer":
            turn = self._turn_handle(params)
            result = await turn.steer(run_input(params))
            return dump_sdk_result(result) or {"turn": turn_ref(turn)}
        if method == "turn/interrupt":
            turn = self._turn_handle(params)
            result = await turn.interrupt()
            return dump_sdk_result(result) or {"turn": turn_ref(turn)}
        if method == "thread/compact/start":
            thread = self._thread_handle(required_thread_id(params))
            result = await thread.compact()
            return dump_sdk_result(result)
        return None

    def _thread_handle(self, thread_id: str) -> Any:
        cached = self._threads.get(thread_id)
        if cached is not None:
            return cached
        async_thread = getattr(self._sdk, "AsyncThread", None) if self._sdk is not None else None
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

    async def _update_thread_settings(
        self,
        thread: Any,
        params: Mapping[str, Any],
    ) -> Any:
        settings = params.get("settings")
        if not isinstance(settings, dict):
            settings = {}
        update_kwargs = {
            "model": optional_string(params.get("model") or settings.get("model")),
            "effort": optional_string(params.get("effort") or settings.get("effort")),
            "approval_mode": sdk_approval_mode(
                self._sdk,
                params.get("approvalPolicy") or settings.get("approvalPolicy"),
            ),
            "sandbox": sdk_sandbox(
                self._sdk,
                params.get("sandbox") or settings.get("sandbox"),
            ),
        }
        update_kwargs = {
            key: value for key, value in update_kwargs.items() if value is not None
        }
        for method_name in (
            "update_settings",
            "configure",
            "update",
            "set_settings",
        ):
            update = getattr(thread, method_name, None)
            if callable(update):
                return await maybe_await(update(**update_kwargs))
        raise RuntimeInvalidRequestError(
            "Codex SDK thread does not expose a settings update method"
        )

    def _remember_thread(self, thread: Any) -> None:
        thread_id = id_of(thread)
        if thread_id is not None:
            self._threads[thread_id] = thread

    def _remember_turn(self, thread_id: str, turn: Any) -> None:
        turn_id = id_of(turn)
        if turn_id is not None:
            self._turns[turn_id] = turn
        self._turns[thread_id] = turn

    def _turn_handle(self, params: Mapping[str, Any]) -> Any:
        for key in ("turnId", "turn_id", "expectedTurnId"):
            value = params.get(key)
            if isinstance(value, str) and value in self._turns:
                return self._turns[value]
        thread_id = required_thread_id(params)
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
                message = notification_dict(notification, thread_id, turn_id)
                if message.get("method") in {
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

    async def _emit(self, message: dict[str, Any]) -> None:
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
