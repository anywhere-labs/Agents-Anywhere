from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from typing import Any

from jsonschema import Draft202012Validator

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
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.dsh import discovery, provider_config
from connector.runtimes.dsh.runtime import DshRuntime

DSH_CONFIG_SCHEMA_REVISION = 2
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

    @property
    def instance_policy(self) -> RuntimeInstancePolicy:
        return "multiple"

    @property
    def max_instances(self) -> int | None:
        return None

    async def discover(self) -> RuntimeTypeDescriptor:
        values = provider_config.default_config_values()
        result = await self._discoverer(values)
        self._last_discovery = result
        metadata = dict(result.metadata or {})
        metadata.update(
            {
                "protocolVersion": "1.0",
                "profile": "web",
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
            capabilities=provider_config.dsh_capabilities(),
            reason=(
                result.reason
                if result.available
                else result.reason or "DeepSeek Harness is unavailable"
            ),
            config_schema=await self.get_config_schema(),
            instance_policy=self.instance_policy,
            max_instances=self.max_instances,
            recommended=False,
            metadata=metadata,
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        return RuntimeConfigSchema(
            runtime=self.runtime,
            revision=DSH_CONFIG_SCHEMA_REVISION,
            schema=provider_config.dsh_config_schema(),
            ui_schema={
                "order": [
                    "dshHome",
                    "startupTimeoutMs",
                    "requestTimeoutMs",
                    "maxRestartAttempts",
                    "restartBackoffMs",
                ],
                "dshHome": {"component": "path"},
            },
            defaults=provider_config.default_config_values(),
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
        if not result.available or not result.configured or result.endpoint is None:
            raise RuntimeInvalidRequestError(result.reason or "DSH is unavailable")
        metadata = dict(result.metadata or {})
        metadata.update(
            {
                "protocolVersion": "1.0",
                "profile": "web",
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
                key=dsh_home,
                label=f"DSH Home {dsh_home!r}",
            ),
            RuntimeResourceClaim(
                kind="dsh_bridge_endpoint",
                key=endpoint,
                label=f"DSH bridge endpoint {endpoint!r}",
            ),
        )

    def session_source_key(self, config: RuntimeConfig) -> RuntimeSourceKey:
        return RuntimeSourceKey(
            kind="dsh_bridge_endpoint",
            key=str(provider_config.endpoint_path(dict(config.values))),
        )
