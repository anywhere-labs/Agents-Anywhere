from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.codex.sdk_client import CodexSdkClient, _create_sdk_client


def test_codex_sdk_client_delegates_runtime_protocol_methods() -> None:
    asyncio.run(_test_codex_sdk_client_delegates_runtime_protocol_methods())


async def _test_codex_sdk_client_delegates_runtime_protocol_methods() -> None:
    native = _NativeSdkClient()
    client = CodexSdkClient(native)

    async def handler(message: dict[str, Any]) -> None:
        native.handled.append(message)

    await client.start(handler)
    result = await client.request("thread/list", {"limit": 1})
    await client.respond("req_1", {"decision": "approve"})
    await client.stop()

    assert native.started is True
    assert native.stopped is True
    assert native.requests == [("thread/list", {"limit": 1})]
    assert native.responses == [("req_1", {"decision": "approve"})]
    assert result == {"ok": True}


def test_create_sdk_client_prefers_explicit_runtime_factory() -> None:
    config = RuntimeConfig(runtime="codex", revision=1, values={"sdkMode": "sdk"})
    sdk = _FakeSdkModule()

    client = _create_sdk_client(sdk, config)

    assert isinstance(client, _NativeSdkClient)
    assert sdk.created_with == config


class _NativeSdkClient:
    def __init__(self) -> None:
        self.started = False
        self.stopped = False
        self.handled: list[dict[str, Any]] = []
        self.requests: list[tuple[str, dict[str, Any]]] = []
        self.responses: list[tuple[str | int, dict[str, Any]]] = []

    async def start(self, handler: Any) -> None:
        self.started = True
        await handler({"method": "ready"})

    async def stop(self) -> None:
        self.stopped = True

    async def request(
        self,
        method: str,
        params: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.requests.append((method, dict(params or {})))
        return {"ok": True}

    async def respond(
        self,
        request_id: str | int,
        result: Mapping[str, Any] | None = None,
    ) -> None:
        self.responses.append((request_id, dict(result or {})))


class _FakeSdkModule:
    def __init__(self) -> None:
        self.created_with: RuntimeConfig | None = None

    def create_runtime_client(self, config: RuntimeConfig) -> _NativeSdkClient:
        self.created_with = config
        return _NativeSdkClient()
