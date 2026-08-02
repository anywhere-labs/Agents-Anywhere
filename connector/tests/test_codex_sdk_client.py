from __future__ import annotations

import asyncio
from collections.abc import Mapping
from types import TracebackType
from typing import Any, Self

from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.codex.sdk_client import (
    CodexSdkClient,
    _create_sdk_client,
    _sdk_config,
)


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


def test_create_sdk_client_prefers_async_codex_sdk_entrypoint() -> None:
    config = RuntimeConfig(
        runtime="codex",
        revision=1,
        values={
            "sdkMode": "sdk",
            "executablePath": "/opt/codex",
            "environment": {"EXAMPLE": "1"},
        },
    )
    sdk = _FakeAsyncCodexSdkModule()

    client = _create_sdk_client(sdk, config)

    assert isinstance(client, _FakeAsyncCodex)
    assert isinstance(client.config, _FakeCodexConfig)
    assert client.config.codex_bin == "/opt/codex"
    assert client.config.env == {"EXAMPLE": "1"}


def test_codex_sdk_client_adapts_async_codex_thread_turn_flow() -> None:
    asyncio.run(_test_codex_sdk_client_adapts_async_codex_thread_turn_flow())


async def _test_codex_sdk_client_adapts_async_codex_thread_turn_flow() -> None:
    sdk = _FakeAsyncCodexSdkModule()
    native = _FakeAsyncCodex(_sdk_config(sdk, _sdk_config_values()))
    client = CodexSdkClient(native, sdk=sdk)
    notifications: list[dict[str, Any]] = []

    async def handler(message: dict[str, Any]) -> None:
        notifications.append(message)

    await client.start(handler)
    models = await client.request("model/list")
    started = await client.request(
        "thread/start",
        {
            "cwd": "/repo",
            "model": "gpt-example",
            "approvalPolicy": "never",
            "sandbox": "workspace-write",
        },
    )
    turn = await client.request(
        "turn/start",
        {
            "threadId": "thread_sdk",
            "input": [{"type": "text", "text": "hello"}],
        },
    )
    steered = await client.request(
        "turn/steer",
        {
            "threadId": "thread_sdk",
            "expectedTurnId": "turn_sdk",
            "input": [{"type": "text", "text": "more"}],
        },
    )
    interrupted = await client.request(
        "turn/interrupt",
        {"threadId": "thread_sdk", "turnId": "turn_sdk"},
    )
    await asyncio.sleep(0)
    await client.stop()

    assert models["data"][0]["id"] == "gpt-example"
    assert started["thread"]["id"] == "thread_sdk"
    assert turn["turn"]["id"] == "turn_sdk"
    assert steered["turnId"] == "turn_sdk"
    assert interrupted["turn"]["id"] == "turn_sdk"
    assert native.entered is True
    assert native.exited is True
    assert native.started_kwargs["approval_mode"] == _FakeApprovalMode.deny_all
    assert native.started_kwargs["sandbox"] == _FakeSandbox.workspace_write
    assert notifications[0]["method"] == "turn/started"
    assert notifications[0]["params"]["turn"]["id"] == "turn_sdk"
    assert any(message["method"] == "turn/completed" for message in notifications)


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


def _sdk_config_values() -> RuntimeConfig:
    return RuntimeConfig(
        runtime="codex",
        revision=1,
        values={"sdkMode": "sdk", "executablePath": "/opt/codex"},
    )


class _FakeApprovalMode:
    deny_all = "deny_all"
    auto_review = "auto_review"


class _FakeSandbox:
    read_only = "read-only"
    workspace_write = "workspace-write"
    full_access = "full-access"


class _FakeCodexConfig:
    def __init__(
        self,
        codex_bin: str | None = None,
        env: dict[str, str] | None = None,
        client_name: str = "",
        client_title: str = "",
    ) -> None:
        self.codex_bin = codex_bin
        self.env = env
        self.client_name = client_name
        self.client_title = client_title


class _FakeAsyncCodexSdkModule:
    ApprovalMode = _FakeApprovalMode
    Sandbox = _FakeSandbox
    CodexConfig = _FakeCodexConfig

    def AsyncCodex(self, config: _FakeCodexConfig | None = None) -> _FakeAsyncCodex:
        return _FakeAsyncCodex(config)

    def AsyncThread(self, codex: _FakeAsyncCodex, thread_id: str) -> _FakeThread:
        return _FakeThread(codex, thread_id)


class _FakeAsyncCodex:
    def __init__(self, config: _FakeCodexConfig | None = None) -> None:
        self.config = config
        self.entered = False
        self.exited = False
        self.started_kwargs: dict[str, Any] = {}

    async def __aenter__(self) -> Self:
        self.entered = True
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        _ = exc_type
        _ = exc
        _ = tb
        self.exited = True

    async def models(self, include_hidden: bool = False) -> _FakeModelDump:
        _ = include_hidden
        return _FakeModelDump({"data": [{"id": "gpt-example"}]})

    async def thread_start(self, **kwargs: Any) -> _FakeThread:
        self.started_kwargs = kwargs
        return _FakeThread(self, "thread_sdk")


class _FakeThread:
    def __init__(self, codex: _FakeAsyncCodex, thread_id: str) -> None:
        self.codex = codex
        self.id = thread_id

    async def read(self, include_turns: bool = False) -> _FakeModelDump:
        _ = include_turns
        return _FakeModelDump({"thread": {"id": self.id, "items": []}})

    async def turn(self, input: Any, **kwargs: Any) -> _FakeTurn:
        _ = input
        _ = kwargs
        return _FakeTurn()

    async def compact(self) -> dict[str, Any]:
        return {}


class _FakeTurn:
    id = "turn_sdk"

    async def steer(self, input: Any) -> _FakeModelDump:
        _ = input
        return _FakeModelDump({"turnId": self.id})

    async def interrupt(self) -> dict[str, Any]:
        return {}

    async def stream(self) -> Any:
        yield _FakeModelDump(
            {
                "method": "turn/completed",
                "params": {"threadId": "thread_sdk", "turnId": self.id},
            }
        )


class _FakeModelDump:
    def __init__(self, value: dict[str, Any]) -> None:
        self.value = value

    def model_dump(self, **kwargs: Any) -> dict[str, Any]:
        _ = kwargs
        return self.value
