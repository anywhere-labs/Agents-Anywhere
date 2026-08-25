from __future__ import annotations

import sys
from collections.abc import Callable, Mapping
from typing import Any

from jsonschema import Draft202012Validator

from connector.core.json_kv import JsonKeyValueStore
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInstancePolicy,
    RuntimeInvalidRequestError,
    RuntimeProvider,
    RuntimeResourceClaim,
    RuntimeSourceKey,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.filesystem import filesystem_resource_key
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex import provider_config
from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.sdk.binary import (
    codex_runtime_environment,
    runtime_binary_metadata,
    select_codex_runtime_binary,
)
from connector.runtimes.codex.sdk.client import sdk_client_from_config
from connector.runtimes.codex.sdk.discovery import check_codex_sdk
from connector.runtimes.custom_models import normalize_custom_models
from connector.runtimes.model_gateway import model_gateway_from_config

SdkChecker = Callable[[], dict[str, Any]]
SdkClientFactory = Callable[[RuntimeConfig], Any]
CODEX_CONFIG_SCHEMA_REVISION = 5


class CodexProvider(RuntimeProvider):
    @property
    def runtime(self) -> str:
        return "codex"

    @property
    def runtime_type(self) -> str:
        return "codex"

    @property
    def display_name(self) -> str:
        return "Codex"

    @property
    def description(self) -> str:
        return "OpenAI Codex runtime"

    @property
    def recommended(self) -> bool:
        return True

    @property
    def recommendation_rank(self) -> int:
        return 10

    @property
    def instance_policy(self) -> RuntimeInstancePolicy:
        return "multiple"

    @property
    def max_instances(self) -> int | None:
        return None

    def __init__(
        self,
        sdk_checker: SdkChecker | None = None,
        sdk_client_factory: SdkClientFactory | None = None,
    ) -> None:
        self._sdk_checker = sdk_checker or check_codex_sdk
        self._sdk_client_factory = sdk_client_factory or sdk_client_from_config
        self._discovered_sdk: dict[str, Any] | None = None

    async def discover(self) -> RuntimeTypeDescriptor:
        sdk = self._sdk_checker()
        self._discovered_sdk = sdk
        available = bool(sdk.get("available"))
        runtime_environment, shell_path = codex_runtime_environment(None)
        binary_selection = select_codex_runtime_binary(
            "prefer_system",
            runtime_environment,
            shell_path,
        )
        reason = None
        if not available:
            reason = "Codex SDK is unavailable"
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            description=self.description,
            available=available,
            recommended=self.recommended,
            recommendation_rank=self.recommendation_rank,
            capabilities=provider_config.codex_capabilities(),
            reason=reason,
            config_schema=await self.get_config_schema(),
            instance_policy=self.instance_policy,
            max_instances=self.max_instances,
            metadata={
                "configured": available,
                "sdk": sdk,
                "runtimeBinary": runtime_binary_metadata(binary_selection),
                "platform": sys.platform,
            },
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        schema = provider_config.codex_config_schema()
        return RuntimeConfigSchema(
            runtime=self.runtime,
            revision=CODEX_CONFIG_SCHEMA_REVISION,
            schema=schema,
            ui_schema={
                "order": [
                    "useSystemCodex",
                    "codexExecutablePath",
                    "codexHome",
                    "modelGateway",
                    "environment",
                    "customModels",
                ],
                "codexExecutablePath": {"component": "path"},
                "codexHome": {"component": "path"},
                "modelGateway": {"component": "modelGateway"},
                "environment": {"component": "keyValue"},
                "customModels": {"component": "customModels"},
            },
            defaults={
                "useSystemCodex": True,
                "environment": {},
                "customModels": [],
            },
        )

    async def validate_config(
        self,
        values: Mapping[str, Any],
    ) -> RuntimeConfig:
        raw_values = dict(values)
        model_gateway = model_gateway_from_config(raw_values.get("modelGateway"))
        if model_gateway is None:
            raw_values.pop("modelGateway", None)
        else:
            raw_values["modelGateway"] = model_gateway.to_config_values()
        use_system_codex = provider_config.normalize_system_codex_preference(
            raw_values.get("useSystemCodex"),
        )
        raw_values["useSystemCodex"] = use_system_codex
        codex_executable_path = provider_config.normalize_codex_executable_path(
            raw_values.get("codexExecutablePath")
        )
        if codex_executable_path is None:
            raw_values.pop("codexExecutablePath", None)
        else:
            raw_values["codexExecutablePath"] = codex_executable_path
        configured_codex_home = provider_config.normalize_codex_home(
            raw_values.get("codexHome")
        )
        if configured_codex_home is None:
            raw_values.pop("codexHome", None)
        else:
            raw_values["codexHome"] = configured_codex_home
        schema = (await self.get_config_schema()).schema
        errors = sorted(
            Draft202012Validator(schema).iter_errors(raw_values),
            key=lambda error: list(error.absolute_path),
        )
        if errors:
            path = "/" + "/".join(str(part) for part in errors[0].absolute_path)
            raise RuntimeInvalidRequestError(
                f"codex config is invalid at {path or '/'}: {errors[0].message}"
            )

        sdk = self._discovered_sdk or self._sdk_checker()
        if not sdk.get("available"):
            raise RuntimeInvalidRequestError("Codex SDK is not available")
        provider_config.merge_environment(raw_values.get("environment"))
        provider_config.validate_codex_executable_path(codex_executable_path)
        codex_home = provider_config.effective_codex_home(configured_codex_home)
        provider_config.validate_codex_home(codex_home)
        binary_mode = provider_config.runtime_binary_mode_for_system_preference(
            use_system_codex
        )
        runtime_environment, shell_path = codex_runtime_environment(
            raw_values.get("environment"),
            codex_home=codex_home,
        )
        binary_selection = select_codex_runtime_binary(
            binary_mode,
            runtime_environment,
            shell_path,
            configured_path=codex_executable_path,
        )

        normalized_values: dict[str, Any] = {
            "useSystemCodex": use_system_codex,
            "environment": dict(raw_values.get("environment") or {}),
            "customModels": normalize_custom_models(raw_values.get("customModels")),
            "codexHome": codex_home,
        }
        if model_gateway is not None:
            normalized_values["modelGateway"] = model_gateway.to_config_values()
        if codex_executable_path is not None:
            normalized_values["codexExecutablePath"] = codex_executable_path

        return RuntimeConfig(
            runtime=self.runtime,
            revision=CODEX_CONFIG_SCHEMA_REVISION,
            values=normalized_values,
            schema=schema,
            ui_schema=(await self.get_config_schema()).ui_schema,
            metadata={
                "sdk": sdk,
                "runtimeBinary": runtime_binary_metadata(binary_selection),
                "codexHome": codex_home,
                "platform": sys.platform,
            },
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        sdk = config.metadata.get("sdk") if isinstance(config.metadata, dict) else None
        if isinstance(sdk, dict) and not sdk.get("available", True):
            raise RuntimeInvalidRequestError("Codex SDK is not available")
        client = self._sdk_client_factory(config)
        return CodexRuntime(
            config=config,
            host=host,
            client=client,
            client_message_kv=JsonKeyValueStore.default(),
        )

    def resource_claims(
        self,
        config: RuntimeConfig,
    ) -> tuple[RuntimeResourceClaim, ...]:
        codex_home = provider_config.canonical_path(str(config.values["codexHome"]))
        return (
            RuntimeResourceClaim(
                kind="codex_home",
                key=filesystem_resource_key(codex_home),
                label=f"Codex Home {codex_home!r}",
            ),
        )

    def session_source_key(self, config: RuntimeConfig) -> RuntimeSourceKey:
        return RuntimeSourceKey(
            kind="codex_home",
            key=filesystem_resource_key(str(config.values["codexHome"])),
        )
