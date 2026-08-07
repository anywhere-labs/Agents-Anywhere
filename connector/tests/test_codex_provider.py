from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

import pytest

from connector.runtime_protocol import RuntimeConfig, RuntimeInvalidRequestError
from connector.runtimes.codex.provider import CodexProvider
from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.sdk.runtime_client import (
    CodexCompactResult,
    CodexInterruptTurnRequest,
    CodexModelListResult,
    CodexStartThreadRequest,
    CodexStartTurnRequest,
    CodexSteerTurnRequest,
    CodexThreadListResult,
    CodexThreadReadResult,
    CodexThreadResult,
    CodexTurnResult,
)


def test_codex_provider_requires_sdk_for_runnable_surface() -> None:
    asyncio.run(_test_codex_provider_requires_sdk_for_runnable_surface())


async def _test_codex_provider_requires_sdk_for_runnable_surface() -> None:
    provider = CodexProvider(sdk_checker=_missing_sdk)

    item = await provider.discover()

    assert item.available is False
    assert item.configured is False
    assert item.capabilities["commands"] is False
    assert item.capabilities["ipc"] is False
    assert item.metadata["sdk"]["available"] is False
    assert "appServer" not in item.metadata
    assert item.reason == "Codex SDK is unavailable"


def test_codex_provider_treats_sdk_as_only_active_surface() -> None:
    asyncio.run(_test_codex_provider_treats_sdk_as_only_active_surface())


async def _test_codex_provider_treats_sdk_as_only_active_surface() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    item = await provider.discover()

    assert item.available is True
    assert item.configured is True
    assert item.metadata["sdk"]["available"] is True
    assert "appServer" not in item.metadata
    assert item.reason is None


def test_codex_provider_schema_exposes_no_ipc_or_app_server_switches() -> None:
    asyncio.run(_test_codex_provider_schema_exposes_no_ipc_or_app_server_switches())


async def _test_codex_provider_schema_exposes_no_ipc_or_app_server_switches() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    schema = await provider.get_config_schema()

    assert schema.defaults == {"environment": {}}
    assert schema.ui_schema["order"] == ["environment"]
    assert set(schema.schema["properties"]) == {"environment"}
    assert "sdkMode" not in schema.schema["properties"]
    assert "ipcEnabled" not in schema.schema["properties"]
    assert "executablePath" not in schema.schema["properties"]


def test_codex_provider_validates_sdk_config() -> None:
    asyncio.run(_test_codex_provider_validates_sdk_config())


async def _test_codex_provider_validates_sdk_config() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    config = await provider.validate_config({"environment": {"EXAMPLE": "1"}})

    assert config.runtime == "codex"
    assert config.values == {"environment": {"EXAMPLE": "1"}}
    assert config.metadata["sdk"]["available"] is True
    assert "launchTarget" not in config.metadata


def test_codex_provider_rejects_missing_sdk() -> None:
    asyncio.run(_test_codex_provider_rejects_missing_sdk())


async def _test_codex_provider_rejects_missing_sdk() -> None:
    provider = CodexProvider(sdk_checker=_missing_sdk)

    with pytest.raises(RuntimeInvalidRequestError, match="SDK is not available"):
        await provider.validate_config({})


def test_codex_provider_rejects_legacy_config_fields() -> None:
    asyncio.run(_test_codex_provider_rejects_legacy_config_fields())


async def _test_codex_provider_rejects_legacy_config_fields() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    with pytest.raises(RuntimeInvalidRequestError, match="Additional properties"):
        await provider.validate_config({"sdkMode": "app-server"})
    with pytest.raises(RuntimeInvalidRequestError, match="Additional properties"):
        await provider.validate_config({"ipcEnabled": True})
    with pytest.raises(RuntimeInvalidRequestError, match="Additional properties"):
        await provider.validate_config({"executablePath": "/opt/codex"})


def test_codex_provider_rejects_protected_environment() -> None:
    asyncio.run(_test_codex_provider_rejects_protected_environment())


async def _test_codex_provider_rejects_protected_environment() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    with pytest.raises(RuntimeInvalidRequestError, match="managed by the connector"):
        await provider.validate_config(
            {"environment": {"AGENT_SERVER_URL": "http://x"}}
        )


def test_codex_provider_creates_sdk_runtime() -> None:
    asyncio.run(_test_codex_provider_creates_sdk_runtime())


async def _test_codex_provider_creates_sdk_runtime() -> None:
    created: list[RuntimeConfig] = []

    def factory(config: RuntimeConfig) -> _FakeSdkClient:
        created.append(config)
        return _FakeSdkClient()

    provider = CodexProvider(
        sdk_checker=_available_sdk,
        sdk_client_factory=factory,
    )
    config = await provider.validate_config({})

    runtime = await provider.create_runtime(config, _NoHost())

    assert isinstance(runtime, CodexRuntime)
    assert created == [config]


def test_codex_provider_rejects_runtime_with_unavailable_sdk_metadata() -> None:
    asyncio.run(_test_codex_provider_rejects_runtime_with_unavailable_sdk_metadata())


async def _test_codex_provider_rejects_runtime_with_unavailable_sdk_metadata() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    with pytest.raises(RuntimeInvalidRequestError, match="SDK is not available"):
        await provider.create_runtime(
            RuntimeConfig(
                runtime="codex",
                revision=1,
                values={"environment": {}},
                metadata={"sdk": _missing_sdk()},
            ),
            _NoHost(),
        )


def _available_sdk() -> dict[str, Any]:
    return {
        "available": True,
        "package": "openai-codex",
        "version": "1.0",
    }


def _missing_sdk() -> dict[str, Any]:
    return {
        "available": False,
        "package": "openai-codex",
        "reason": "package not installed",
    }


class _NoHost:
    @property
    def connector_id(self) -> str:
        return "conn_test"


class _FakeSdkClient:
    async def start(self, handler: Any) -> None:
        _ = handler

    async def stop(self) -> None:
        return None

    async def list_models(self) -> CodexModelListResult:
        return CodexModelListResult(models=())

    async def list_threads(
        self,
        limit: int = 100,
        cursor: str | None = None,
    ) -> CodexThreadListResult:
        _ = limit
        _ = cursor
        return CodexThreadListResult(threads=())

    async def read_thread(
        self,
        thread_id: str,
        include_turns: bool = True,
    ) -> CodexThreadReadResult:
        _ = thread_id
        _ = include_turns
        return CodexThreadReadResult(thread={})

    async def start_thread(self, request: CodexStartThreadRequest) -> CodexThreadResult:
        _ = request
        return CodexThreadResult(thread_id=None, payload={})

    async def start_turn(self, request: CodexStartTurnRequest) -> CodexTurnResult:
        _ = request
        return CodexTurnResult(turn_id=None, payload={})

    async def steer_turn(self, request: CodexSteerTurnRequest) -> CodexTurnResult:
        _ = request
        return CodexTurnResult(turn_id=None, payload={})

    async def interrupt_turn(
        self,
        request: CodexInterruptTurnRequest,
    ) -> CodexTurnResult:
        _ = request
        return CodexTurnResult(turn_id=None, payload={})

    async def compact_thread(self, thread_id: str) -> CodexCompactResult:
        _ = thread_id
        return CodexCompactResult(payload={})

    async def respond(
        self, request_id: str | int, result: Mapping[str, Any] | None = None
    ) -> None:
        _ = request_id
        _ = result
