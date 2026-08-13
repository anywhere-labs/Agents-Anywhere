from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from typing import Any

from jsonschema import Draft202012Validator

from connector.core.json_kv import JsonKeyValueStore
from connector.launch import launch_target
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInstanceSpec,
    RuntimeInvalidRequestError,
    RuntimeProvider,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.claude import discovery, provider_config
from connector.runtimes.claude.runtime import ClaudeRuntime
from connector.runtimes.custom_models import normalize_custom_models
from connector.runtimes.model_gateway import model_gateway_from_config

CLAUDE_CONFIG_SCHEMA_REVISION = 4


class ClaudeProvider(RuntimeProvider):
    @property
    def runtime_type(self) -> str:
        return "claude"

    @property
    def display_name(self) -> str:
        return "Claude"

    @property
    def description(self) -> str:
        return "Anthropic Claude Code runtime"

    @property
    def recommended(self) -> bool:
        return True

    @property
    def recommendation_rank(self) -> int:
        return 20

    def __init__(
        self,
        sdk_loader: discovery.SdkLoader | None = None,
        command_checker: discovery.CommandChecker | None = None,
    ) -> None:
        self._sdk_loader = sdk_loader or discovery.load_claude_sdk
        self._command_checker = command_checker or discovery.check_claude_target
        self._discovered_sdk: dict[str, Any] | None = None
        self._discovered_target = None

    async def discover(self) -> RuntimeTypeDescriptor:
        sdk = discovery.check_claude_sdk(self._sdk_loader)
        self._discovered_sdk = sdk
        environment = provider_config.merge_environment({})
        self._discovered_target = discovery.discover_claude_target(
            self._command_checker,
            environment,
        )
        available = bool(sdk.get("available"))
        reason = (
            None if available else sdk.get("reason") or "claude-agent-sdk unavailable"
        )
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            description=self.description,
            available=available,
            recommended=self.recommended,
            recommendation_rank=self.recommendation_rank,
            capabilities=provider_config.claude_capabilities(),
            reason=reason,
            config_schema=await self.get_config_schema(),
            metadata={
                "sdk": sdk,
                "launchTarget": discovery.target_metadata(self._discovered_target),
                "platform": sys.platform,
            },
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        schema = provider_config.claude_config_schema()
        return RuntimeConfigSchema(
            runtime_type=self.runtime_type,
            revision=CLAUDE_CONFIG_SCHEMA_REVISION,
            schema=schema,
            ui_schema={
                "order": [
                    "executablePath",
                    "modelGateway",
                    "environment",
                    "customModels",
                ],
                "modelGateway": {"component": "modelGateway"},
                "environment": {"component": "keyValue"},
                "customModels": {"component": "customModels"},
            },
            defaults={"environment": {}, "customModels": []},
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
        schema = (await self.get_config_schema()).schema
        errors = sorted(
            Draft202012Validator(schema).iter_errors(raw_values),
            key=lambda error: list(error.absolute_path),
        )
        if errors:
            path = "/" + "/".join(str(part) for part in errors[0].absolute_path)
            raise RuntimeInvalidRequestError(
                f"claude config is invalid at {path or '/'}: {errors[0].message}"
            )

        environment = provider_config.merge_environment(raw_values.get("environment"))
        sdk = self._discovered_sdk or discovery.check_claude_sdk(self._sdk_loader)
        if not sdk.get("available"):
            raise RuntimeInvalidRequestError("Claude Agent SDK is not available")

        executable_path = raw_values.get("executablePath")
        launch_metadata = discovery.target_metadata(self._discovered_target)
        if isinstance(executable_path, str) and executable_path:
            target = launch_target(
                "configured",
                os.path.expandvars(os.path.expanduser(executable_path)),
            )
            result = self._command_checker(target, environment)
            if result.get("status") != "ok":
                raise RuntimeInvalidRequestError(
                    "Claude executable validation failed: "
                    f"{result.get('reason') or result.get('status')}"
                )
            launch_metadata = discovery.target_metadata(target)

        normalized_values: dict[str, Any] = {
            "environment": dict(raw_values.get("environment") or {}),
            "customModels": normalize_custom_models(raw_values.get("customModels")),
        }
        if model_gateway is not None:
            normalized_values["modelGateway"] = model_gateway.to_config_values()
        if isinstance(executable_path, str) and executable_path:
            normalized_values["executablePath"] = executable_path

        config_schema = await self.get_config_schema()
        return RuntimeConfig(
            runtime_type=self.runtime_type,
            revision=CLAUDE_CONFIG_SCHEMA_REVISION,
            values=normalized_values,
            schema=schema,
            ui_schema=config_schema.ui_schema,
            metadata={
                "sdk": sdk,
                "launchTarget": launch_metadata,
                "platform": sys.platform,
            },
        )

    async def create_runtime(
        self,
        instance: RuntimeInstanceSpec,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        _ = instance
        sdk = config.metadata.get("sdk") if isinstance(config.metadata, dict) else None
        if isinstance(sdk, dict) and not sdk.get("available", True):
            raise RuntimeInvalidRequestError("Claude Agent SDK is not available")
        return ClaudeRuntime(
            config=config,
            host=host,
            sdk_loader=self._sdk_loader,
            client_message_kv=JsonKeyValueStore.default(),
        )
