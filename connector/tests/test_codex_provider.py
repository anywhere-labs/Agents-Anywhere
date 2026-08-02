from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

import pytest

from connector.launch import LaunchTarget, launch_target
from connector.runtime_protocol import RuntimeConfig, RuntimeInvalidRequestError
from connector.runtimes.codex.provider import CodexProvider
from connector.runtimes.codex.runtime import CodexRuntime


def test_codex_provider_treats_sdk_as_primary_runnable_surface() -> None:
    asyncio.run(_test_codex_provider_treats_sdk_as_primary_runnable_surface())


async def _test_codex_provider_treats_sdk_as_primary_runnable_surface() -> None:
    provider = CodexProvider(
        sdk_checker=lambda: {
            "available": True,
            "package": "openai-codex",
            "version": "1.0",
        },
        command_checker=_missing_command,
    )

    item = await provider.discover()

    assert item.available is True
    assert item.configured is True
    assert item.capabilities["commands"] is True
    assert item.capabilities["ipc"] is False
    assert item.metadata["sdk"]["available"] is True
    assert item.metadata["appServer"]["available"] is False
    assert item.reason is None


def test_codex_provider_schema_marks_ipc_beta_and_platform_scope() -> None:
    asyncio.run(_test_codex_provider_schema_marks_ipc_beta_and_platform_scope())


async def _test_codex_provider_schema_marks_ipc_beta_and_platform_scope() -> None:
    provider = CodexProvider(
        sdk_checker=_missing_sdk,
        command_checker=_missing_command,
    )

    schema = await provider.get_config_schema()
    ipc = schema.schema["properties"]["ipcEnabled"]

    assert schema.defaults["sdkMode"] == "auto"
    assert schema.ui_schema["order"] == [
        "sdkMode",
        "executablePath",
        "ipcEnabled",
        "environment",
    ]
    assert ipc["title"] == "Codex IPC (Beta)"
    assert "Tested on macOS only" in ipc["description"]
    assert "Windows and Linux have not yet been tested" in ipc["description"]
    assert "runtime instability" in ipc["description"]


def test_codex_provider_auto_prefers_sdk() -> None:
    asyncio.run(_test_codex_provider_auto_prefers_sdk())


async def _test_codex_provider_auto_prefers_sdk() -> None:
    provider = CodexProvider(
        sdk_checker=lambda: {
            "available": True,
            "package": "openai-codex",
            "version": "1.0",
        },
        command_checker=_available_command,
    )
    await provider.discover()

    config = await provider.validate_config({"sdkMode": "auto", "ipcEnabled": False})

    assert config.runtime == "codex"
    assert config.values["sdkMode"] == "sdk"
    assert config.values["requestedSdkMode"] == "auto"
    assert config.values["ipcEnabled"] is False


def test_codex_provider_auto_falls_back_to_app_server() -> None:
    asyncio.run(_test_codex_provider_auto_falls_back_to_app_server())


async def _test_codex_provider_auto_falls_back_to_app_server() -> None:
    provider = CodexProvider(
        sdk_checker=_missing_sdk,
        command_checker=_available_command,
    )

    config = await provider.validate_config(
        {
            "sdkMode": "auto",
            "executablePath": "/opt/codex",
        }
    )

    assert config.values["sdkMode"] == "app-server"
    assert config.values["executablePath"] == "/opt/codex"
    assert config.metadata["launchTarget"]["path"] == "/opt/codex"


def test_codex_provider_rejects_missing_forced_sdk() -> None:
    asyncio.run(_test_codex_provider_rejects_missing_forced_sdk())


async def _test_codex_provider_rejects_missing_forced_sdk() -> None:
    provider = CodexProvider(
        sdk_checker=_missing_sdk,
        command_checker=_available_command,
    )

    with pytest.raises(RuntimeInvalidRequestError, match="SDK is not available"):
        await provider.validate_config({"sdkMode": "sdk"})


def test_codex_provider_accepts_forced_sdk() -> None:
    asyncio.run(_test_codex_provider_accepts_forced_sdk())


async def _test_codex_provider_accepts_forced_sdk() -> None:
    provider = CodexProvider(
        sdk_checker=lambda: {
            "available": True,
            "package": "openai-codex",
            "version": "1.0",
        },
        command_checker=_available_command,
    )

    config = await provider.validate_config({"sdkMode": "sdk"})

    assert config.values["sdkMode"] == "sdk"


def test_codex_provider_validates_configured_executable() -> None:
    asyncio.run(_test_codex_provider_validates_configured_executable())


async def _test_codex_provider_validates_configured_executable() -> None:
    seen: list[str] = []

    async def check(
        target: LaunchTarget, environment: Mapping[str, str]
    ) -> dict[str, Any]:
        seen.append(target.path)
        assert environment["EXAMPLE"] == "1"
        return {"status": "ok", "source": target.source, "path": target.path}

    provider = CodexProvider(sdk_checker=_missing_sdk, command_checker=check)

    config = await provider.validate_config(
        {
            "sdkMode": "app-server",
            "executablePath": "/custom/codex",
            "environment": {"EXAMPLE": "1"},
        }
    )

    assert seen == ["/custom/codex"]
    assert config.values["sdkMode"] == "app-server"
    assert config.values["executablePath"] == "/custom/codex"
    assert config.values["environment"] == {"EXAMPLE": "1"}


def test_codex_provider_rejects_protected_environment() -> None:
    asyncio.run(_test_codex_provider_rejects_protected_environment())


async def _test_codex_provider_rejects_protected_environment() -> None:
    provider = CodexProvider(
        sdk_checker=_missing_sdk, command_checker=_available_command
    )

    with pytest.raises(RuntimeInvalidRequestError, match="managed by the connector"):
        await provider.validate_config(
            {"environment": {"AGENT_SERVER_URL": "http://x"}}
        )


def test_codex_provider_creates_native_runtime() -> None:
    asyncio.run(_test_codex_provider_creates_native_runtime())


async def _test_codex_provider_creates_native_runtime() -> None:
    provider = CodexProvider(
        sdk_checker=_missing_sdk, command_checker=_available_command
    )
    config = await provider.validate_config({"sdkMode": "app-server"})

    runtime = await provider.create_runtime(config, _NoHost())

    assert isinstance(runtime, CodexRuntime)
    assert await runtime.get_config() == config


def test_codex_provider_creates_sdk_runtime() -> None:
    asyncio.run(_test_codex_provider_creates_sdk_runtime())


async def _test_codex_provider_creates_sdk_runtime() -> None:
    created: list[RuntimeConfig] = []

    def factory(config: RuntimeConfig) -> _FakeSdkClient:
        created.append(config)
        return _FakeSdkClient()

    provider = CodexProvider(
        sdk_checker=lambda: {
            "available": True,
            "package": "openai-codex",
            "version": "1.0",
        },
        command_checker=_missing_command,
        sdk_client_factory=factory,
    )
    config = await provider.validate_config({"sdkMode": "sdk"})

    runtime = await provider.create_runtime(config, _NoHost())

    assert isinstance(runtime, CodexRuntime)
    assert created == [config]


def test_codex_provider_rejects_runtime_without_resolved_mode() -> None:
    asyncio.run(_test_codex_provider_rejects_runtime_without_resolved_mode())


async def _test_codex_provider_rejects_runtime_without_resolved_mode() -> None:
    provider = CodexProvider(
        sdk_checker=_missing_sdk, command_checker=_available_command
    )

    with pytest.raises(RuntimeInvalidRequestError, match="sdkMode=sdk"):
        await provider.create_runtime(
            RuntimeConfig(runtime="codex", revision=1, values={"sdkMode": "auto"}),
            _NoHost(),
        )


async def _available_command(
    target: LaunchTarget,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    _ = environment
    selected = launch_target("cli", "/opt/codex")
    return {
        "status": "ok",
        "source": selected.source,
        "path": selected.path,
        "version": "codex 1.0",
    }


async def _missing_command(
    target: LaunchTarget,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    _ = environment
    return {
        "status": "missing",
        "source": target.source,
        "path": target.path,
        "reason": "file not found",
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

    async def request(
        self, method: str, params: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        _ = method
        _ = params
        return {}

    async def respond(
        self, request_id: str | int, result: Mapping[str, Any] | None = None
    ) -> None:
        _ = request_id
        _ = result
