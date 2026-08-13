from __future__ import annotations

import asyncio
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeInstanceSpec,
    RuntimeInvalidRequestError,
)
from connector.runtimes.codex import provider_config
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
    assert item.runtime_type == "codex"
    assert item.recommended is True
    assert item.capabilities["commands"] is False
    assert item.capabilities["ipc"] is False
    assert item.metadata["sdk"]["available"] is False
    assert item.metadata["runtimeBinary"]["mode"] == "prefer_system"
    assert "appServer" not in item.metadata
    assert item.reason == "Codex SDK is unavailable"


def test_codex_provider_treats_sdk_as_only_active_surface() -> None:
    asyncio.run(_test_codex_provider_treats_sdk_as_only_active_surface())


async def _test_codex_provider_treats_sdk_as_only_active_surface() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    item = await provider.discover()

    assert item.available is True
    assert item.runtime_type == "codex"
    assert item.recommended is True
    assert item.metadata["sdk"]["available"] is True
    assert item.metadata["runtimeBinary"]["mode"] == "prefer_system"
    assert "appServer" not in item.metadata
    assert item.reason is None


def test_codex_provider_schema_exposes_no_ipc_or_app_server_switches() -> None:
    asyncio.run(_test_codex_provider_schema_exposes_no_ipc_or_app_server_switches())


async def _test_codex_provider_schema_exposes_no_ipc_or_app_server_switches() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    schema = await provider.get_config_schema()

    assert schema.defaults == {
        "useSystemCodex": True,
        "environment": {},
        "customModels": [],
    }
    assert schema.ui_schema["order"] == [
        "useSystemCodex",
        "codexExecutablePath",
        "codexHome",
        "modelGateway",
        "environment",
        "customModels",
    ]
    assert schema.ui_schema["customModels"]["component"] == "customModels"
    assert schema.ui_schema["modelGateway"]["component"] == "modelGateway"
    assert set(schema.schema["properties"]) == {
        "codexExecutablePath",
        "codexHome",
        "customModels",
        "environment",
        "modelGateway",
        "useSystemCodex",
    }
    assert schema.schema["properties"]["useSystemCodex"] == {
        "type": "boolean",
        "title": "Use System Codex",
        "description": (
            "Use the Codex executable found in the user's login shell PATH. "
            "If it is unavailable, fall back to the bundled Codex executable. "
            "Turn this off to always use the bundled Codex executable."
        ),
        "metadata": {
            "i18n": {
                "labelKey": (
                    "dashboard.device.runtimeConfigFields.useSystemCodex.label"
                ),
                "descriptionKey": (
                    "dashboard.device.runtimeConfigFields.useSystemCodex.description"
                ),
            }
        },
        "default": True,
    }
    assert "sdkMode" not in schema.schema["properties"]
    assert "ipcEnabled" not in schema.schema["properties"]
    assert "executablePath" not in schema.schema["properties"]
    assert schema.ui_schema["codexExecutablePath"]["component"] == "path"
    assert schema.ui_schema["codexHome"]["component"] == "path"
    assert schema.schema["properties"]["codexExecutablePath"]["metadata"] == {
        "i18n": {
            "labelKey": (
                "dashboard.device.runtimeConfigFields.codexExecutablePath.label"
            ),
            "descriptionKey": (
                "dashboard.device.runtimeConfigFields.codexExecutablePath.description"
            ),
        }
    }


def test_codex_provider_validates_sdk_config() -> None:
    asyncio.run(_test_codex_provider_validates_sdk_config())


async def _test_codex_provider_validates_sdk_config() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    config = await provider.validate_config(
        {
            "environment": {"EXAMPLE": "1"},
            "customModels": [
                {
                    "modelId": " gpt-local-test ",
                    "displayName": " GPT Local Test ",
                    "efforts": [
                        {
                            "effortId": " high ",
                            "displayName": " High ",
                        }
                    ],
                }
            ],
        }
    )

    assert config.runtime_type == "codex"
    assert config.values == {
        "useSystemCodex": True,
        "codexHome": provider_config.effective_codex_home(None),
        "environment": {"EXAMPLE": "1"},
        "customModels": [
            {
                "modelId": "gpt-local-test",
                "displayName": "GPT Local Test",
                "efforts": [
                    {
                        "effortId": "high",
                        "displayName": "High",
                    }
                ],
            }
        ],
    }
    assert config.metadata["sdk"]["available"] is True
    assert config.metadata["runtimeBinary"]["mode"] == "prefer_system"
    assert "launchTarget" not in config.metadata


def test_codex_provider_preserves_model_gateway_config() -> None:
    asyncio.run(_test_codex_provider_preserves_model_gateway_config())


async def _test_codex_provider_preserves_model_gateway_config() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    config = await provider.validate_config(
        {
            "modelGateway": {
                "baseUrl": " https://gateway.example/v1/ ",
                "apiKey": " gateway-secret ",
            }
        }
    )

    assert config.values["modelGateway"] == {
        "baseUrl": "https://gateway.example/v1",
        "apiKey": " gateway-secret ",
    }


def test_codex_provider_rejects_invalid_model_gateway_url() -> None:
    asyncio.run(_test_codex_provider_rejects_invalid_model_gateway_url())


async def _test_codex_provider_rejects_invalid_model_gateway_url() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    with pytest.raises(RuntimeInvalidRequestError, match="absolute HTTP or HTTPS URL"):
        await provider.validate_config(
            {
                "modelGateway": {
                    "baseUrl": "gateway.example/v1",
                    "apiKey": "gateway-secret",
                }
            }
        )


def test_codex_provider_can_force_bundled_codex() -> None:
    asyncio.run(_test_codex_provider_can_force_bundled_codex())


async def _test_codex_provider_can_force_bundled_codex() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    config = await provider.validate_config({"useSystemCodex": False})

    assert config.values["useSystemCodex"] is False
    assert config.metadata["runtimeBinary"]["mode"] == "sdk_bundled"
    assert config.metadata["runtimeBinary"]["source"] == "sdk_bundled"


def test_codex_provider_uses_configured_executable_path(tmp_path: Path) -> None:
    asyncio.run(_test_codex_provider_uses_configured_executable_path(tmp_path))


async def _test_codex_provider_uses_configured_executable_path(
    tmp_path: Path,
) -> None:
    codex_bin = tmp_path / "codex-custom"
    codex_bin.write_text("#!/bin/sh\n", encoding="utf-8")
    codex_bin.chmod(0o755)
    provider = CodexProvider(sdk_checker=_available_sdk)

    config = await provider.validate_config(
        {
            "useSystemCodex": False,
            "codexExecutablePath": f"  {codex_bin}  ",
        }
    )

    assert config.values["codexExecutablePath"] == str(codex_bin)
    assert config.metadata["runtimeBinary"]["source"] == "configured"
    assert config.metadata["runtimeBinary"]["codexBin"] == str(codex_bin)


def test_codex_provider_ignores_empty_executable_path() -> None:
    asyncio.run(_test_codex_provider_ignores_empty_executable_path())


async def _test_codex_provider_ignores_empty_executable_path() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    config = await provider.validate_config({"codexExecutablePath": "   "})

    assert "codexExecutablePath" not in config.values


def test_codex_provider_normalizes_explicit_home(tmp_path: Path) -> None:
    asyncio.run(_test_codex_provider_normalizes_explicit_home(tmp_path))


async def _test_codex_provider_normalizes_explicit_home(tmp_path: Path) -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    config = await provider.validate_config({"codexHome": f"  {tmp_path}  "})

    assert config.values["codexHome"] == str(tmp_path.resolve())
    assert provider.resource_claims(config)[0].kind == "codex_home"


def test_codex_provider_rejects_codex_home_environment_override() -> None:
    asyncio.run(_test_codex_provider_rejects_codex_home_environment_override())


async def _test_codex_provider_rejects_codex_home_environment_override() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    with pytest.raises(RuntimeInvalidRequestError, match="managed by the connector"):
        await provider.validate_config({"environment": {"CODEX_HOME": "/tmp/x"}})


def test_codex_provider_rejects_non_executable_path(tmp_path: Path) -> None:
    asyncio.run(_test_codex_provider_rejects_non_executable_path(tmp_path))


async def _test_codex_provider_rejects_non_executable_path(tmp_path: Path) -> None:
    codex_bin = tmp_path / "codex-custom"
    codex_bin.write_text("not executable\n", encoding="utf-8")
    provider = CodexProvider(sdk_checker=_available_sdk)

    with pytest.raises(RuntimeInvalidRequestError, match="executable file"):
        await provider.validate_config({"codexExecutablePath": str(codex_bin)})


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
    with pytest.raises(RuntimeInvalidRequestError, match="Additional properties"):
        await provider.validate_config({"runtimeBinaryMode": "prefer_system"})


def test_codex_provider_rejects_duplicate_custom_models() -> None:
    asyncio.run(_test_codex_provider_rejects_duplicate_custom_models())


async def _test_codex_provider_rejects_duplicate_custom_models() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    with pytest.raises(RuntimeInvalidRequestError, match="duplicate modelId"):
        await provider.validate_config(
            {
                "customModels": [
                    {"modelId": "gpt-local-test", "displayName": "Local"},
                    {"modelId": "gpt-local-test", "displayName": "Duplicate"},
                ]
            }
        )


def test_codex_provider_rejects_duplicate_custom_efforts() -> None:
    asyncio.run(_test_codex_provider_rejects_duplicate_custom_efforts())


async def _test_codex_provider_rejects_duplicate_custom_efforts() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    with pytest.raises(RuntimeInvalidRequestError, match="duplicate effortId"):
        await provider.validate_config(
            {
                "customModels": [
                    {
                        "modelId": "gpt-local-test",
                        "displayName": "Local",
                        "efforts": [
                            {"effortId": "high", "displayName": "High"},
                            {"effortId": "high", "displayName": "Duplicate"},
                        ],
                    }
                ]
            }
        )


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

    runtime = await provider.create_runtime(_instance(), config, _NoHost())

    assert isinstance(runtime, CodexRuntime)
    assert created == [config]


def test_codex_provider_rejects_runtime_with_unavailable_sdk_metadata() -> None:
    asyncio.run(_test_codex_provider_rejects_runtime_with_unavailable_sdk_metadata())


async def _test_codex_provider_rejects_runtime_with_unavailable_sdk_metadata() -> None:
    provider = CodexProvider(sdk_checker=_available_sdk)

    with pytest.raises(RuntimeInvalidRequestError, match="SDK is not available"):
        await provider.create_runtime(
            _instance(),
            RuntimeConfig(
                runtime_type="codex",
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

    @property
    def session_namespace(self) -> str:
        return "conn_test:runtime-codex-1"


def _instance() -> RuntimeInstanceSpec:
    return RuntimeInstanceSpec(
        runtime_id="runtime-codex-1",
        runtime_type="codex",
        name="Codex 1",
    )


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
