from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
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
from connector.runtimes.dsh import discovery, provider_config
from connector.runtimes.dsh.runtime import DshRuntime

DSH_CONFIG_SCHEMA_REVISION = 1
Discovery = Callable[[dict[str, Any]], Awaitable[discovery.DshDiscovery]]


class DshProvider(RuntimeProvider):
    def __init__(self, discoverer: Discovery | None = None) -> None:
        self._discoverer = discoverer or discovery.discover
        self._last_discovery: discovery.DshDiscovery | None = None

    @property
    def runtime(self) -> str:
        return "dsh"

    @property
    def runtime_type(self) -> str:
        return "local-process"

    @property
    def display_name(self) -> str:
        return "DeepSeek Harness"

    async def discover(self) -> RuntimeInventoryItem:
        values = provider_config.default_config_values()
        result = await self._discoverer(values)
        self._last_discovery = result
        metadata = dict(result.metadata or {})
        if result.version:
            metadata["dshVersion"] = result.version
        metadata.update(
            {
                "protocolVersion": "1.0",
                "profile": values["profile"],
                "storageMode": "dsh-native",
                "sameSessionWriterLimit": 1,
                "crossProcessWriterExclusion": False,
            }
        )
        return RuntimeInventoryItem(
            runtime=self.runtime,
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            available=result.available,
            configured=result.configured,
            capabilities=provider_config.dsh_capabilities(),
            reason=result.reason,
            config_schema=await self.get_config_schema(),
            metadata=metadata,
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        return RuntimeConfigSchema(
            runtime=self.runtime,
            revision=DSH_CONFIG_SCHEMA_REVISION,
            schema=provider_config.dsh_config_schema(),
            ui_schema={
                "order": [
                    "executablePath",
                    "profile",
                    "dshHome",
                    "environment",
                    "startupTimeoutMs",
                    "requestTimeoutMs",
                    "shutdownTimeoutMs",
                    "killGraceMs",
                    "maxRestartAttempts",
                    "restartBackoffMs",
                ],
                "environment": {"component": "secretKeyValue", "writeOnly": True},
                "dshHome": {"component": "path"},
                "executablePath": {"component": "path"},
            },
            defaults=provider_config.default_config_values(),
            metadata={
                "storageMode": "dsh-native",
                "sameSessionWriterLimit": 1,
                "crossProcessWriterExclusion": False,
            },
        )

    async def validate_config(self, values: Mapping[str, Any]) -> RuntimeConfig:
        raw = dict(values)
        schema_info = await self.get_config_schema()
        errors = sorted(
            Draft202012Validator(schema_info.schema).iter_errors(raw),
            key=lambda error: list(error.absolute_path),
        )
        if errors:
            path = "/" + "/".join(str(part) for part in errors[0].absolute_path)
            raise RuntimeInvalidRequestError(
                f"dsh config is invalid at {path or '/'}: {errors[0].message}"
            )
        normalized = provider_config.normalized_config_values(raw)
        result = await self._discoverer(normalized)
        self._last_discovery = result
        if not result.available or not result.configured or result.target is None:
            raise RuntimeInvalidRequestError(result.reason or "DSH is unavailable")
        metadata = dict(result.metadata or {})
        metadata.update(
            {
                "dshVersion": result.version,
                "protocolVersion": "1.0",
                "profile": normalized["profile"],
                "storageMode": "dsh-native",
                "sameSessionWriterLimit": 1,
                "crossProcessWriterExclusion": False,
                "launchTarget": {
                    "source": result.target.source,
                    "path": result.target.path,
                    "launcher": result.target.launcher,
                },
            }
        )
        # Environment values are never copied into metadata or returned diagnostics.
        return RuntimeConfig(
            runtime=self.runtime,
            revision=DSH_CONFIG_SCHEMA_REVISION,
            values=normalized,
            schema=schema_info.schema,
            ui_schema=schema_info.ui_schema,
            metadata=metadata,
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        return DshRuntime(config=config, host=host)
