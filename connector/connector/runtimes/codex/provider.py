from __future__ import annotations

import sys
from collections.abc import Callable, Mapping
from typing import Any

from jsonschema import Draft202012Validator

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInvalidRequestError,
    RuntimeInventoryItem,
    RuntimeProvider,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.custom_models import normalize_custom_models
from connector.runtimes.codex import provider_config
from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.sdk.client import sdk_client_from_config
from connector.runtimes.codex.sdk.discovery import check_codex_sdk

SdkChecker = Callable[[], dict[str, Any]]
SdkClientFactory = Callable[[RuntimeConfig], Any]
CODEX_CONFIG_SCHEMA_REVISION = 2


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

    def __init__(
        self,
        sdk_checker: SdkChecker | None = None,
        sdk_client_factory: SdkClientFactory | None = None,
    ) -> None:
        self._sdk_checker = sdk_checker or check_codex_sdk
        self._sdk_client_factory = sdk_client_factory or sdk_client_from_config
        self._discovered_sdk: dict[str, Any] | None = None

    async def discover(self) -> RuntimeInventoryItem:
        sdk = self._sdk_checker()
        self._discovered_sdk = sdk
        available = bool(sdk.get("available"))
        reason = None
        if not available:
            reason = "Codex SDK is unavailable"
        return RuntimeInventoryItem(
            runtime=self.runtime,
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            available=available,
            configured=available,
            capabilities=provider_config.codex_capabilities(),
            reason=reason,
            config_schema=await self.get_config_schema(),
            metadata={
                "sdk": sdk,
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
                "order": ["environment", "customModels"],
                "environment": {"component": "keyValue"},
                "customModels": {"component": "customModels"},
            },
            defaults={
                "environment": {},
                "customModels": [],
            },
        )

    async def validate_config(
        self,
        values: Mapping[str, Any],
    ) -> RuntimeConfig:
        raw_values = dict(values)
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

        normalized_values: dict[str, Any] = {
            "environment": dict(raw_values.get("environment") or {}),
            "customModels": normalize_custom_models(raw_values.get("customModels")),
        }

        return RuntimeConfig(
            runtime=self.runtime,
            revision=CODEX_CONFIG_SCHEMA_REVISION,
            values=normalized_values,
            schema=schema,
            ui_schema=(await self.get_config_schema()).ui_schema,
            metadata={
                "sdk": sdk,
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
        return CodexRuntime(config=config, host=host, client=client)
