from __future__ import annotations

import importlib
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import RuntimeConfig, RuntimeInvalidRequestError
from connector.runtimes.codex.client import CodexRuntimeClient, NotificationHandler


class CodexSdkClient:
    """Adapter from the Codex SDK client shape to the runtime client protocol.

    The connector runtime wants a tiny async JSON-RPC-like surface. Keeping the
    SDK-specific discovery here lets `CodexRuntime` stay protocol-oriented while
    Codex moves away from the hand-written app-server process client.
    """

    def __init__(self, client: Any) -> None:
        self._client = client

    async def start(self, handler: NotificationHandler) -> None:
        start = getattr(self._client, "start", None)
        if callable(start):
            await _maybe_await(_call_with_optional_handler(start, handler))

    async def stop(self) -> None:
        stop = getattr(self._client, "stop", None)
        if callable(stop):
            await _maybe_await(stop())

    async def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        request = getattr(self._client, "request", None)
        if not callable(request):
            raise RuntimeInvalidRequestError(
                "Codex SDK client does not expose request(method, params)"
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


def sdk_client_from_config(config: RuntimeConfig) -> CodexRuntimeClient:
    sdk = _load_codex_sdk()
    client = _create_sdk_client(sdk, config)
    return CodexSdkClient(client)


def _load_codex_sdk() -> Any:
    for module_name in ("openai_codex", "codex"):
        try:
            return importlib.import_module(module_name)
        except ImportError:
            continue
    raise RuntimeInvalidRequestError("Codex SDK package is not importable")


def _create_sdk_client(sdk: Any, config: RuntimeConfig) -> Any:
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


def _call_with_optional_handler(function: Any, handler: NotificationHandler) -> Any:
    try:
        return function(handler)
    except TypeError:
        return function()


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value
