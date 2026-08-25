from __future__ import annotations

import asyncio
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeConflictError,
    RuntimeHostClient,
    RuntimeInstance,
    RuntimeInstanceSpec,
    RuntimeInvalidRequestError,
    RuntimeSupervisor,
)
from connector.runtime_protocol.filesystem import filesystem_resource_key
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
    assert item.metadata["configured"] is False
    assert item.instance_policy == "multiple"
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
    assert item.metadata["configured"] is True
    assert item.instance_policy == "multiple"
    assert item.max_instances is None
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

    assert config.runtime == "codex"
    assert config.values == {
        "useSystemCodex": True,
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
        "codexHome": provider_config.canonical_path(Path.home() / ".codex"),
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
    with pytest.raises(RuntimeInvalidRequestError, match="managed by the connector"):
        await provider.validate_config({"environment": {"CODEX_HOME": "/tmp/bypass"}})


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
    assert runtime._pending_messages._connector_id == _NoHost().session_namespace


def test_codex_provider_canonicalizes_home_claims(tmp_path: Path) -> None:
    async def run() -> None:
        real_home = tmp_path / "real-home"
        real_home.mkdir()
        symlink_home = tmp_path / "linked-home"
        symlink_home.symlink_to(real_home, target_is_directory=True)
        provider = CodexProvider(sdk_checker=_available_sdk)

        direct = await provider.validate_config(
            {"codexHome": str(real_home / ".." / "real-home")}
        )
        linked = await provider.validate_config({"codexHome": str(symlink_home)})

        assert direct.values["codexHome"] == str(real_home.resolve())
        assert linked.values["codexHome"] == str(real_home.resolve())
        assert provider.resource_claims(direct) == provider.resource_claims(linked)
        assert provider.session_source_key(direct) == provider.session_source_key(
            linked
        )

    asyncio.run(run())


def test_codex_provider_claims_effective_environment_home(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    async def run() -> None:
        environment_home = tmp_path / "environment-home"
        monkeypatch.setenv("CODEX_HOME", str(environment_home / "."))
        provider = CodexProvider(sdk_checker=_available_sdk)

        config = await provider.validate_config({})
        claim = provider.resource_claims(config)[0]

        assert config.values["codexHome"] == str(environment_home.resolve())
        assert claim.key == filesystem_resource_key(environment_home)

    asyncio.run(run())


@pytest.mark.skipif(sys.platform != "darwin", reason="Darwin path identity semantics")
def test_codex_provider_blocks_case_and_unicode_home_aliases(tmp_path: Path) -> None:
    async def run() -> None:
        provider = CodexProvider(sdk_checker=_available_sdk)
        composed = tmp_path / "Cod\u00e9x-Home"
        decomposed = tmp_path / "CODE\u0301X-HOME"

        first = await provider.validate_config({"codexHome": str(composed)})
        second = await provider.validate_config({"codexHome": str(decomposed)})

        first_claim = provider.resource_claims(first)[0]
        second_claim = provider.resource_claims(second)[0]
        assert (first_claim.kind, first_claim.key, first_claim.mode) == (
            second_claim.kind,
            second_claim.key,
            second_claim.mode,
        )
        assert provider.session_source_key(first) == provider.session_source_key(second)

    asyncio.run(run())


def test_codex_provider_runs_distinct_homes_and_rejects_same_source(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        clients: list[_FakeSdkClient] = []

        def factory(_config: RuntimeConfig) -> _FakeSdkClient:
            client = _FakeSdkClient()
            clients.append(client)
            return client

        provider = CodexProvider(
            sdk_checker=_available_sdk,
            sdk_client_factory=factory,
        )
        supervisor = RuntimeSupervisor(providers=(provider,), host=_NoHost())
        first = await supervisor.start(
            RuntimeInstanceSpec("rti_codex_first", "codex", "First Codex"),
            {"codexHome": str(tmp_path / "first")},
        )
        second = await supervisor.start(
            RuntimeInstanceSpec("rti_codex_second", "codex", "Second Codex"),
            {"codexHome": str(tmp_path / "second")},
        )

        assert isinstance(first, RuntimeInstance)
        assert isinstance(second, RuntimeInstance)
        assert isinstance(first.native_runtime, CodexRuntime)
        assert isinstance(second.native_runtime, CodexRuntime)
        assert first.identity.runtime == second.identity.runtime == "codex"
        assert first.identity.runtime_id == "rti_codex_first"
        assert second.identity.runtime_id == "rti_codex_second"
        assert first.native_runtime.host.session_namespace != (
            second.native_runtime.host.session_namespace
        )
        assert len(clients) == 2

        with pytest.raises(RuntimeConflictError, match="already used"):
            await supervisor.start(
                RuntimeInstanceSpec("rti_codex_conflict", "codex", "Conflict"),
                {"codexHome": str(tmp_path / "first" / ".")},
            )

    asyncio.run(run())


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


class _NoHost(RuntimeHostClient):
    @property
    def connector_id(self) -> str:
        return "conn_test"

    @property
    def session_namespace(self) -> str:
        return "conn_test:codex:rti_test"


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
