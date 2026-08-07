from __future__ import annotations

import sys
from collections.abc import Mapping
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
from connector.runtimes.claude import discovery, provider_config
from connector.runtimes.claude.runtime import ClaudeRuntime


class ClaudeProvider(RuntimeProvider):
    @property
    def runtime(self) -> str:
        return "claude"

    @property
    def runtime_type(self) -> str:
        return "claude"

    @property
    def display_name(self) -> str:
        return "Claude"

    def __init__(
        self,
        sdk_loader: discovery.SdkLoader | None = None,
        command_checker: discovery.CommandChecker | None = None,
    ) -> None:
        self._sdk_loader = sdk_loader or discovery.load_claude_sdk
        self._command_checker = command_checker or discovery.check_claude_target
        self._discovered_sdk: dict[str, Any] | None = None
        self._discovered_target: discovery.LaunchTarget | None = None

    async def discover(self) -> RuntimeInventoryItem:
        sdk = discovery.check_sdk(self._sdk_loader)
        target = discovery.discover_claude_target(self._command_checker, {})
        self._discovered_sdk = sdk
        self._discovered_target = target
        available = bool(sdk.get("available"))
        reason = None if available else "claude-agent-sdk is not installed"
        return RuntimeInventoryItem(
            runtime=self.runtime,
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            available=available,
            configured=available,
            capabilities=provider_config.claude_capabilities(),
            reason=reason,
            config_schema=await self.get_config_schema(),
            metadata={
                "sdk": sdk,
                "cli": discovery.target_metadata(target),
                "platform": sys.platform,
            },
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        schema = provider_config.claude_config_schema(self._discovered_target)
        return RuntimeConfigSchema(
            runtime=self.runtime,
            revision=1,
            schema=schema,
            ui_schema={
                "order": ["executablePath", "environment"],
                "executablePath": {"component": "path"},
                "environment": {"component": "keyValue"},
            },
            defaults={
                "environment": {},
            },
        )

    async def validate_config(
        self,
        values: Mapping[str, Any],
    ) -> RuntimeConfig:
        raw_values = dict(values)
        schema_obj = await self.get_config_schema()
        errors = sorted(
            Draft202012Validator(schema_obj.schema).iter_errors(raw_values),
            key=lambda error: list(error.absolute_path),
        )
        if errors:
            path = "/" + "/".join(str(part) for part in errors[0].absolute_path)
            raise RuntimeInvalidRequestError(
                f"claude config is invalid at {path or '/'}: {errors[0].message}"
            )
        environment = provider_config.merge_environment(raw_values.get("environment"))
        sdk = self._discovered_sdk or discovery.check_sdk(self._sdk_loader)
        if not sdk.get("available"):
            raise RuntimeInvalidRequestError("claude-agent-sdk is not available")
        target = discovery.resolve_target(
            raw_values=raw_values,
            environment=environment,
            discovered_target=self._discovered_target,
            command_checker=self._command_checker,
        )
        normalized_values: dict[str, Any] = {
            "environment": dict(raw_values.get("environment") or {}),
        }
        if target is not None:
            normalized_values["executablePath"] = target.path
        return RuntimeConfig(
            runtime=self.runtime,
            revision=1,
            values=normalized_values,
            schema=schema_obj.schema,
            ui_schema=schema_obj.ui_schema,
            metadata={
                "sdk": sdk,
                "cli": discovery.target_metadata(target),
                "platform": sys.platform,
            },
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        return ClaudeRuntime(config=config, host=host, sdk_loader=self._sdk_loader)
