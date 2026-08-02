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
            await _maybe_await(_call_with_optional_handler(start, handler))
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
            await _maybe_await(stop())
        elif self._entered_client is not None and hasattr(self._client, "__aexit__"):
            await self._client.__aexit__(None, None, None)
            self._entered_client = None
        elif hasattr(self._client, "close"):
            await _maybe_await(self._client.close())

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
        result = await _maybe_await(request(method, dict(params or {})))
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
        await _maybe_await(respond(request_id, dict(result or {})))

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
            return _dump_sdk_result(result)
        if method == "thread/list" and callable(
            getattr(self._client, "thread_list", None)
        ):
            result = await self._client.thread_list(
                cursor=_optional_string(params.get("cursor")),
                limit=_optional_int(params.get("limit")),
            )
            return _dump_sdk_result(result)
        if method == "thread/read":
            thread_id = _required_thread_id(params)
            thread = self._thread_handle(thread_id)
            result = await thread.read(
                include_turns=bool(params.get("includeTurns") or params.get("include_turns"))
            )
            return _dump_sdk_result(result)
        if method == "thread/start" and callable(
            getattr(self._client, "thread_start", None)
        ):
            thread = await self._client.thread_start(
                cwd=_optional_string(params.get("cwd")),
                model=_optional_string(params.get("model")),
                approval_mode=_sdk_approval_mode(self._sdk, params.get("approvalPolicy")),
                sandbox=_sdk_sandbox(self._sdk, params.get("sandbox")),
                ephemeral=bool(params.get("ephemeral")) if "ephemeral" in params else None,
            )
            self._remember_thread(thread)
            return {"thread": _thread_ref(thread)}
        if method == "turn/start":
            thread_id = _required_thread_id(params)
            thread = self._thread_handle(thread_id)
            turn = await thread.turn(
                _run_input(params),
                model=_optional_string(params.get("model")),
                effort=_optional_string(params.get("effort")),
                approval_mode=_sdk_approval_mode(self._sdk, params.get("approvalPolicy")),
                sandbox=_sdk_sandbox(self._sdk, params.get("sandbox")),
            )
            self._remember_turn(thread_id, turn)
            await self._emit(
                {
                    "method": "turn/started",
                    "params": {
                        "threadId": thread_id,
                        "turn": _turn_ref(turn),
                    },
                }
            )
            self._start_stream_task(thread_id, turn)
            return {"turn": _turn_ref(turn)}
        if method == "turn/steer":
            turn = self._turn_handle(params)
            result = await turn.steer(_run_input(params))
            return _dump_sdk_result(result) or {"turn": _turn_ref(turn)}
        if method == "turn/interrupt":
            turn = self._turn_handle(params)
            result = await turn.interrupt()
            return _dump_sdk_result(result) or {"turn": _turn_ref(turn)}
        if method == "thread/compact/start":
            thread = self._thread_handle(_required_thread_id(params))
            result = await thread.compact()
            return _dump_sdk_result(result)
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

    def _remember_thread(self, thread: Any) -> None:
        thread_id = _id_of(thread)
        if thread_id is not None:
            self._threads[thread_id] = thread

    def _remember_turn(self, thread_id: str, turn: Any) -> None:
        turn_id = _id_of(turn)
        if turn_id is not None:
            self._turns[turn_id] = turn
        self._turns[thread_id] = turn

    def _turn_handle(self, params: Mapping[str, Any]) -> Any:
        for key in ("turnId", "turn_id", "expectedTurnId"):
            value = params.get(key)
            if isinstance(value, str) and value in self._turns:
                return self._turns[value]
        thread_id = _required_thread_id(params)
        turn = self._turns.get(thread_id)
        if turn is None:
            raise RuntimeInvalidRequestError(
                f"Codex SDK has no active turn for thread {thread_id}"
            )
        return turn

    def _start_stream_task(self, thread_id: str, turn: Any) -> None:
        if not callable(getattr(turn, "stream", None)) or self._handler is None:
            return
        turn_id = _id_of(turn) or thread_id
        old_task = self._stream_tasks.pop(turn_id, None)
        if old_task is not None:
            old_task.cancel()
        self._stream_tasks[turn_id] = asyncio.create_task(
            self._stream_turn(thread_id, turn_id, turn)
        )

    async def _stream_turn(self, thread_id: str, turn_id: str, turn: Any) -> None:
        try:
            async for notification in turn.stream():
                await self._emit(_notification_dict(notification, thread_id, turn_id))
        finally:
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


def _dump_sdk_result(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        raw = dump(mode="json", by_alias=True, exclude_none=True)
        return raw if isinstance(raw, dict) else {}
    if hasattr(value, "__dict__"):
        return {
            key: item
            for key, item in vars(value).items()
            if not key.startswith("_")
        }
    return {}


def _thread_ref(thread: Any) -> dict[str, Any]:
    dumped = _dump_sdk_result(thread)
    thread_id = _id_of(thread) or _optional_string(dumped.get("id"))
    if thread_id is not None:
        dumped.setdefault("id", thread_id)
    return dumped


def _turn_ref(turn: Any) -> dict[str, Any]:
    dumped = _dump_sdk_result(turn)
    turn_id = _id_of(turn) or _optional_string(dumped.get("id"))
    if turn_id is not None:
        dumped.setdefault("id", turn_id)
    return dumped


def _notification_dict(notification: Any, thread_id: str, turn_id: str) -> dict[str, Any]:
    raw = _dump_sdk_result(notification)
    method = raw.get("method")
    params = raw.get("params")
    if isinstance(method, str) and isinstance(params, dict):
        params.setdefault("threadId", thread_id)
        params.setdefault("turnId", turn_id)
        return {"method": method, "params": params}
    event = raw.get("type") or notification.__class__.__name__
    return {
        "method": str(event),
        "params": {
            **raw,
            "threadId": thread_id,
            "turnId": turn_id,
        },
    }


def _run_input(params: Mapping[str, Any]) -> Any:
    raw_input = params.get("input")
    if isinstance(raw_input, str):
        return raw_input
    if isinstance(raw_input, list):
        parts: list[str] = []
        for item in raw_input:
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    return ""


def _required_thread_id(params: Mapping[str, Any]) -> str:
    for key in ("threadId", "thread_id"):
        value = params.get(key)
        if isinstance(value, str) and value:
            return value
    raise RuntimeInvalidRequestError("threadId is required")


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _optional_int(value: Any) -> int | None:
    return value if isinstance(value, int) else None


def _id_of(value: Any) -> str | None:
    raw = getattr(value, "id", None)
    return raw if isinstance(raw, str) and raw else None


def _sdk_approval_mode(sdk: Any | None, value: Any) -> Any:
    approval_mode = getattr(sdk, "ApprovalMode", None) if sdk is not None else None
    if approval_mode is None:
        return None
    if value in {"never", "deny_all", "deny-all"}:
        return getattr(approval_mode, "deny_all", None)
    if value in {"untrusted", "on-request", "auto_review", "auto-review", None}:
        return getattr(approval_mode, "auto_review", None)
    return None


def _sdk_sandbox(sdk: Any | None, value: Any) -> Any:
    sandbox = getattr(sdk, "Sandbox", None) if sdk is not None else None
    if sandbox is None:
        return None
    return {
        "read-only": getattr(sandbox, "read_only", None),
        "read_only": getattr(sandbox, "read_only", None),
        "workspace-write": getattr(sandbox, "workspace_write", None),
        "workspace_write": getattr(sandbox, "workspace_write", None),
        "danger-full-access": getattr(sandbox, "full_access", None),
        "full-access": getattr(sandbox, "full_access", None),
        "full_access": getattr(sandbox, "full_access", None),
    }.get(value)


def _call_with_optional_handler(function: Any, handler: NotificationHandler) -> Any:
    try:
        return function(handler)
    except TypeError:
        return function()


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value
