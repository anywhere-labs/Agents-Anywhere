from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from jsonschema import Draft202012Validator

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInvalidRequestError,
    RuntimeProvider,
    RuntimeResourceClaim,
    RuntimeSourceKey,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.filesystem import filesystem_resource_key
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.dsh import discovery, provider_config
from connector.runtimes.dsh.runtime import DshRuntime

DSH_CONFIG_SCHEMA_REVISION = 3
LEGACY_CONFIG_KEYS = frozenset(
    {
        "environment",
        "executablePath",
        "killGraceMs",
        "profile",
        "shutdownTimeoutMs",
    }
)
Discovery = Callable[[dict[str, Any]], Awaitable[discovery.DshDiscovery]]


class DshProvider(RuntimeProvider):
    def __init__(self, discoverer: Discovery | None = None) -> None:
        self._discoverer = discoverer or discovery.discover
        self._last_discovery: discovery.DshDiscovery | None = None
        self._last_values = provider_config.default_config_values()
        self._preset_catalog: dict[str, Any] = {}

    def _remember(self, result: discovery.DshDiscovery) -> None:
        self._last_discovery = result
        catalog = (result.metadata or {}).get("agentPresetCatalog")
        if isinstance(catalog, dict):
            self._preset_catalog = catalog

    @property
    def runtime(self) -> str:
        return "dsh"

    @property
    def runtime_type(self) -> str:
        return "dsh"

    @property
    def implementation_type(self) -> str:
        return "local-service"

    @property
    def display_name(self) -> str:
        return "DeepSeek Harness"

    @property
    def description(self) -> str:
        return "DeepSeek Harness local service runtime"

    async def discover(self) -> RuntimeTypeDescriptor:
        values = self._last_values
        result = await self._discoverer(values)
        self._remember(result)
        metadata = dict(result.metadata or {})
        metadata.update(
            {
                "protocolVersion": "1.0",
                "readOnly": not provider_config.dsh_capabilities(metadata.get("runtimeCapabilities"))["startTurn"],
                "storageMode": "dsh-native",
                "sameSessionWriterLimit": 1,
                "crossProcessWriterExclusion": False,
                "configured": result.configured,
            }
        )
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            description=self.description,
            implementation_type=self.implementation_type,
            available=result.available,
            capabilities=provider_config.dsh_capabilities(metadata.get("runtimeCapabilities")),
            reason=(
                result.reason
                if result.available
                else result.reason or "DeepSeek Harness is unavailable"
            ),
            config_schema=self._config_schema(),
            instance_policy=self.instance_policy,
            max_instances=self.max_instances,
            recommended=False,
            metadata=metadata,
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        self._remember(await self._discoverer(self._last_values))
        return self._config_schema()

    def _config_schema(self) -> RuntimeConfigSchema:
        schema = provider_config.dsh_config_schema()
        field = self._preset_catalog.get("configField")
        defaults = provider_config.default_config_values()
        if isinstance(field, dict):
            schema["properties"]["defaultAgentPreset"] = dict(field)
            if isinstance(field.get("default"), str):
                defaults["defaultAgentPreset"] = field["default"]
        return RuntimeConfigSchema(
            runtime=self.runtime,
            revision=DSH_CONFIG_SCHEMA_REVISION,
            schema=schema,
            ui_schema={
                "order": [
                    "defaultAgentPreset",
                    "dshHome",
                    "startupTimeoutMs",
                    "requestTimeoutMs",
                    "maxRestartAttempts",
                    "restartBackoffMs",
                ],
                "dshHome": {"component": "path"},
                "defaultAgentPreset": self._preset_catalog.get("uiField", {"component": "select", "options": []}),
            },
            defaults=defaults,
            metadata={
                "storageMode": "dsh-native",
                "sameSessionWriterLimit": 1,
                "crossProcessWriterExclusion": False,
            },
        )

    async def validate_config(self, values: Mapping[str, Any]) -> RuntimeConfig:
        raw = {
            key: value for key, value in values.items() if key not in LEGACY_CONFIG_KEYS
        }
        errors = sorted(
            Draft202012Validator(provider_config.dsh_config_schema()).iter_errors(raw),
            key=lambda error: list(error.absolute_path),
        )
        if errors:
            path = "/" + "/".join(str(part) for part in errors[0].absolute_path)
            raise RuntimeInvalidRequestError(
                f"dsh config is invalid at {path or '/'}: {errors[0].message}"
            )
        normalized = provider_config.normalized_config_values(raw)
        result = await self._discoverer(normalized)
        self._remember(result)
        if not result.available or not result.configured or result.endpoint is None:
            raise RuntimeInvalidRequestError(result.reason or "DSH is unavailable")
        schema_info = self._config_schema()
        if "defaultAgentPreset" not in normalized and "defaultAgentPreset" in schema_info.defaults:
            normalized["defaultAgentPreset"] = schema_info.defaults["defaultAgentPreset"]
        preset = normalized.get("defaultAgentPreset")
        catalog = (result.metadata or {}).get("agentPresetCatalog")
        if preset is not None and isinstance(catalog, dict):
            if not any(row.get("id") == preset and row.get("enabled") is True for row in catalog.get("presets", []) if isinstance(row, dict)):
                raise RuntimeInvalidRequestError("所选 DSH 模式已删除或不可用，请重新选择新会话默认模式。")
        self._last_values = normalized
        metadata = dict(result.metadata or {})
        metadata.update(
            {
                "protocolVersion": "1.0",
                "readOnly": not provider_config.dsh_capabilities(metadata.get("runtimeCapabilities"))["startTurn"],
                "storageMode": "dsh-native",
                "sameSessionWriterLimit": 1,
                "crossProcessWriterExclusion": False,
                "configured": result.configured,
            }
        )
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

    def resource_claims(
        self,
        config: RuntimeConfig,
    ) -> tuple[RuntimeResourceClaim, ...]:
        values = dict(config.values)
        dsh_home = str(provider_config.dsh_home(values))
        endpoint = str(provider_config.endpoint_path(values))
        return (
            RuntimeResourceClaim(
                kind="dsh_home",
                key=filesystem_resource_key(dsh_home),
                label=f"DSH Home {dsh_home!r}",
            ),
            RuntimeResourceClaim(
                kind="dsh_bridge_endpoint",
                key=filesystem_resource_key(endpoint),
                label=f"DSH bridge endpoint {endpoint!r}",
            ),
        )

    def session_source_key(self, config: RuntimeConfig) -> RuntimeSourceKey:
        return RuntimeSourceKey(
            kind="dsh_bridge_endpoint",
            key=filesystem_resource_key(
                provider_config.endpoint_path(dict(config.values))
            ),
        )
