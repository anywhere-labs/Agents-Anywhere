from __future__ import annotations

import asyncio
from typing import Any

import pytest

from connector.runtime_protocol import RuntimeConfig
from connector.runtime_protocol.model_connection import ModelConnectionUnsupportedError
from connector.runtimes.dsh.bridge.client import BridgeRpcError
from connector.runtimes.dsh.discovery import DshDiscovery
from connector.runtimes.dsh.provider import DshProvider
from connector.runtimes.dsh.runtime import DshRuntime

GATEWAY = {"baseUrl": "https://tokens.test/v1", "apiKey": "sk-dsh-secret", "protocol": "openai_chat"}
MODELS = [{"modelId": "gpt-5", "displayName": "GPT-5"}, {"modelId": "deepseek-v3", "displayName": "deepseek-v3"}]


async def _available(_values: dict[str, Any]) -> DshDiscovery:
    return DshDiscovery(available=True, configured=True, metadata={})


class _Host:
    connector_id = "test"
    session_namespace = "test:instance"


class _Client:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[tuple[str, Any]] = []

    async def request(self, method: str, params: Any = None) -> Any:
        self.calls.append((method, params))
        if self.error is not None:
            raise self.error
        return {"provider": "aa-tokens-openai-chat"}


def test_dsh_declares_an_experimental_native_global_connection() -> None:
    descriptor = asyncio.run(DshProvider(discoverer=_available).discover())

    capability = descriptor.model_connection.payload()
    assert capability["maturity"] == "experimental"
    assert capability["scope"] == "native_global"
    assert capability["apply"] == "immediate"
    assert capability["protocols"] == ["openai_chat", "anthropic", "openai_responses"]
    properties = descriptor.config_schema.schema["properties"]
    assert properties["modelGateway"]["properties"]["protocol"]["enum"] == capability["protocols"]


def test_dsh_gateway_needs_a_protocol_and_models() -> None:
    provider = DshProvider(discoverer=_available)

    async def run() -> None:
        defaults = (await provider.get_config_schema()).defaults
        config = await provider.validate_config({**defaults, "modelGateway": GATEWAY, "customModels": MODELS})
        assert config.values["modelGateway"] == GATEWAY
        with pytest.raises(ModelConnectionUnsupportedError):
            await provider.validate_config({**defaults, "modelGateway": GATEWAY})
        missing = {key: value for key, value in GATEWAY.items() if key != "protocol"}
        with pytest.raises(Exception) as caught:
            await provider.validate_config({**defaults, "modelGateway": missing, "customModels": MODELS})
        assert "sk-dsh-secret" not in str(caught.value)

    asyncio.run(run())


def _runtime(values: dict[str, Any]) -> DshRuntime:
    return DshRuntime(RuntimeConfig("dsh", 4, values=values), _Host())


def test_connection_is_handed_to_the_plugin_and_reported() -> None:
    runtime = _runtime({"modelGateway": GATEWAY, "customModels": MODELS})
    client = _Client()

    asyncio.run(runtime._apply_model_connection(client, runtime.config.values))

    assert client.calls == [
        (
            "applyModelConnection",
            {
                "connection": {
                    "protocol": "openai_chat",
                    "baseUrl": "https://tokens.test/v1",
                    "apiKey": "sk-dsh-secret",
                    "models": [{"id": "gpt-5", "name": "GPT-5"}, {"id": "deepseek-v3", "name": "deepseek-v3"}],
                }
            },
        )
    ]
    status = runtime.model_connection_status().payload()
    assert status["state"] == "applied"
    assert status["protocol"] == "openai_chat"
    assert status["scope"] == "native_global"


def test_an_old_plugin_reports_failed_instead_of_ignoring_the_connection() -> None:
    runtime = _runtime({"modelGateway": GATEWAY, "customModels": MODELS})
    client = _Client(BridgeRpcError("METHOD_NOT_FOUND", "unknown method"))

    asyncio.run(runtime._apply_model_connection(client, runtime.config.values))

    status = runtime.model_connection_status().payload()
    assert status["state"] == "failed"
    assert "update the plugin" in status["reason"]


def test_without_a_connection_aa_routes_are_cleared_quietly() -> None:
    runtime = _runtime({})
    old_plugin = _runtime({})

    asyncio.run(runtime._apply_model_connection(_Client(), {}))
    asyncio.run(old_plugin._apply_model_connection(_Client(BridgeRpcError("METHOD_NOT_FOUND", "x")), {}))

    assert runtime.model_connection_status().payload()["state"] == "not_configured"
    assert old_plugin.model_connection_status() is None
