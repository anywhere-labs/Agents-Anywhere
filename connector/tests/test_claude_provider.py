from __future__ import annotations

import asyncio
from collections.abc import Mapping
from types import SimpleNamespace
from typing import Any

import pytest

from connector.launch import LaunchTarget
from connector.runtime_protocol import RuntimeInstanceSpec, RuntimeInvalidRequestError
from connector.runtimes.claude.provider import ClaudeProvider
from connector.runtimes.claude.runtime import ClaudeRuntime


def test_claude_provider_discovers_sdk_with_initial_runtime_actions() -> None:
    asyncio.run(_test_claude_provider_discovers_sdk_with_initial_runtime_actions())


async def _test_claude_provider_discovers_sdk_with_initial_runtime_actions() -> None:
    provider = ClaudeProvider(
        sdk_loader=_sdk,
        command_checker=_missing_command,
    )

    item = await provider.discover()

    assert item.available is True
    assert item.runtime_type == "claude"
    assert item.recommended is True
    assert item.capabilities["modelCatalog"] is True
    assert item.capabilities["createAndStartSession"] is True
    assert item.capabilities["startTurn"] is True
    assert item.capabilities["interruptTurn"] is True
    assert item.capabilities["sessionState"] is True
    assert item.capabilities["sessionDiscovery"] is True
    assert item.capabilities["sessionSnapshot"] is True
    assert item.capabilities["sessionNotices"] is True
    assert item.capabilities["permissionCatalog"] is True
    assert item.capabilities["interactions"] is True
    assert item.capabilities["attachments"] is True
    assert item.capabilities["commands"] is False
    assert item.metadata["sdk"]["available"] is True
    assert item.metadata["platform"]


def test_claude_provider_reports_unavailable_without_sdk() -> None:
    asyncio.run(_test_claude_provider_reports_unavailable_without_sdk())


async def _test_claude_provider_reports_unavailable_without_sdk() -> None:
    def missing_sdk() -> Any:
        raise ModuleNotFoundError("claude_agent_sdk")

    provider = ClaudeProvider(
        sdk_loader=missing_sdk,
        command_checker=_missing_command,
    )

    item = await provider.discover()

    assert item.available is False
    assert item.runtime_type == "claude"
    assert "claude_agent_sdk" in (item.reason or "")


def test_claude_provider_schema_and_config_validation() -> None:
    asyncio.run(_test_claude_provider_schema_and_config_validation())


async def _test_claude_provider_schema_and_config_validation() -> None:
    provider = ClaudeProvider(
        sdk_loader=_sdk,
        command_checker=_available_command,
    )

    schema = await provider.get_config_schema()
    config = await provider.validate_config(
        {
            "executablePath": "/opt/claude",
            "environment": {"EXAMPLE": "1"},
            "customModels": [
                {
                    "modelId": " claude-local-test ",
                    "displayName": " Claude Local Test ",
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

    assert schema.defaults == {"environment": {}, "customModels": []}
    assert schema.ui_schema["customModels"]["component"] == "customModels"
    assert schema.ui_schema["modelGateway"]["component"] == "modelGateway"
    assert set(schema.schema["properties"]) == {
        "customModels",
        "environment",
        "executablePath",
        "modelGateway",
    }
    assert schema.schema["properties"]["executablePath"]["metadata"] == {
        "i18n": {
            "labelKey": (
                "dashboard.device.runtimeConfigFields.claudeExecutablePath.label"
            ),
            "descriptionKey": (
                "dashboard.device.runtimeConfigFields.claudeExecutablePath.description"
            ),
        }
    }
    assert config.runtime_type == "claude"
    assert config.values["executablePath"] == "/opt/claude"
    assert config.values["environment"] == {"EXAMPLE": "1"}
    assert config.values["customModels"] == [
        {
            "modelId": "claude-local-test",
            "displayName": "Claude Local Test",
            "efforts": [
                {
                    "effortId": "high",
                    "displayName": "High",
                }
            ],
        }
    ]
    assert config.metadata["launchTarget"]["path"] == "/opt/claude"


def test_claude_provider_preserves_model_gateway_config() -> None:
    asyncio.run(_test_claude_provider_preserves_model_gateway_config())


async def _test_claude_provider_preserves_model_gateway_config() -> None:
    provider = ClaudeProvider(sdk_loader=_sdk, command_checker=_available_command)

    config = await provider.validate_config(
        {
            "modelGateway": {
                "baseUrl": "https://gateway.example/anthropic/",
                "apiKey": "gateway-secret",
            }
        }
    )

    assert config.values["modelGateway"] == {
        "baseUrl": "https://gateway.example/anthropic",
        "apiKey": "gateway-secret",
    }


def test_claude_provider_rejects_duplicate_custom_models() -> None:
    asyncio.run(_test_claude_provider_rejects_duplicate_custom_models())


async def _test_claude_provider_rejects_duplicate_custom_models() -> None:
    provider = ClaudeProvider(sdk_loader=_sdk, command_checker=_available_command)

    with pytest.raises(RuntimeInvalidRequestError, match="duplicate modelId"):
        await provider.validate_config(
            {
                "customModels": [
                    {"modelId": "claude-local-test", "displayName": "Local"},
                    {"modelId": "claude-local-test", "displayName": "Duplicate"},
                ]
            }
        )


def test_claude_provider_rejects_duplicate_custom_efforts() -> None:
    asyncio.run(_test_claude_provider_rejects_duplicate_custom_efforts())


async def _test_claude_provider_rejects_duplicate_custom_efforts() -> None:
    provider = ClaudeProvider(sdk_loader=_sdk, command_checker=_available_command)

    with pytest.raises(RuntimeInvalidRequestError, match="duplicate effortId"):
        await provider.validate_config(
            {
                "customModels": [
                    {
                        "modelId": "claude-local-test",
                        "displayName": "Local",
                        "efforts": [
                            {"effortId": "high", "displayName": "High"},
                            {"effortId": "high", "displayName": "Duplicate"},
                        ],
                    }
                ]
            }
        )


def test_claude_provider_rejects_protected_environment() -> None:
    asyncio.run(_test_claude_provider_rejects_protected_environment())


async def _test_claude_provider_rejects_protected_environment() -> None:
    provider = ClaudeProvider(sdk_loader=_sdk, command_checker=_available_command)

    with pytest.raises(RuntimeInvalidRequestError, match="managed by the connector"):
        await provider.validate_config(
            {"environment": {"AGENT_SERVER_URL": "http://x"}}
        )


def test_claude_provider_creates_skeleton_runtime() -> None:
    asyncio.run(_test_claude_provider_creates_skeleton_runtime())


async def _test_claude_provider_creates_skeleton_runtime() -> None:
    provider = ClaudeProvider(sdk_loader=_sdk, command_checker=_available_command)
    config = await provider.validate_config({"executablePath": "/opt/claude"})

    runtime = await provider.create_runtime(_instance(), config, _NoHost())

    assert isinstance(runtime, ClaudeRuntime)
    assert await runtime.get_config() == config


def _sdk() -> Any:
    return SimpleNamespace(__version__="1.0")


def _available_command(
    target: LaunchTarget,
    environment: Mapping[str, str],
) -> dict[str, Any]:
    assert environment.get("EXAMPLE") in {None, "1"}
    return {
        "status": "ok",
        "source": target.source,
        "path": target.path,
    }


def _missing_command(
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


class _NoHost:
    @property
    def connector_id(self) -> str:
        return "conn_test"

    @property
    def session_namespace(self) -> str:
        return "conn_test:runtime-claude-1"


def _instance() -> RuntimeInstanceSpec:
    return RuntimeInstanceSpec(
        runtime_id="runtime-claude-1",
        runtime_type="claude",
        name="Claude 1",
    )
