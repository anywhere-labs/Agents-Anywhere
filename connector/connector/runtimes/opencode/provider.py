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
from connector.runtime_protocol.filesystem import canonical_path, filesystem_resource_key
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.opencode import provider_config
from connector.runtimes.opencode.serve import discovery as serve_discovery
from connector.runtimes.opencode.serve.runtime import OpenCodeServiceRuntime

OPENCODE_CONFIG_SCHEMA_REVISION = 2

Discovery = Callable[[Mapping[str, Any]], Awaitable[serve_discovery.ServiceDiscovery]]
Probe = Callable[[Mapping[str, Any]], Awaitable[serve_discovery.ServiceDiscovery]]


class OpenCodeProvider(RuntimeProvider):
    """OpenCode runtime that attaches to the host's own service over HTTP."""

    def __init__(
        self,
        discoverer: Discovery | None = None,
        prober: Probe | None = None,
    ) -> None:
        self._discoverer = discoverer or serve_discovery.discover
        # Reachability is a configuration/start concern. Callers that inject a
        # discoverer (tests, embedders) keep using it for both so a single fake
        # still drives the whole provider surface.
        self._prober = prober or discoverer or serve_discovery.probe
        self._last_discovery: serve_discovery.ServiceDiscovery | None = None
        self._last_values = provider_config.default_config_values()

    def _remember(self, result: serve_discovery.ServiceDiscovery) -> None:
        self._last_discovery = result

    @property
    def runtime(self) -> str:
        return "opencode"

    @property
    def runtime_type(self) -> str:
        return "opencode"

    @property
    def implementation_type(self) -> str:
        return "local-service"

    @property
    def instance_policy(self) -> str:
        return "multiple"

    @property
    def max_instances(self) -> None:
        return None

    @property
    def display_name(self) -> str:
        return "OpenCode"

    @property
    def description(self) -> str:
        return "OpenCode host service runtime (HTTP/SSE, nothing installed in OpenCode)"

    async def discover(self) -> RuntimeTypeDescriptor:
        """Report the supported runtime type. Service reachability is not discovery."""

        values = self._last_values
        result = await self._discoverer(values)
        self._remember(result)
        metadata = dict(result.metadata or {})
        capabilities = provider_config.opencode_capabilities(metadata.get("runtimeCapabilities"))
        metadata.update(
            {
                "transport": "service-http",
                "storageMode": "opencode-native",
                "sameSessionWriterLimit": 1,
                "crossProcessWriterExclusion": False,
                "configured": result.configured,
            }
        )
        if "runtimeCapabilities" in metadata:
            metadata["readOnly"] = not capabilities["startTurn"]
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            description=self.description,
            implementation_type=self.implementation_type,
            available=result.available,
            capabilities=capabilities,
            reason=(
                None
                if result.available
                else result.reason or "OpenCode is unavailable"
            ),
            config_schema=self._config_schema(),
            instance_policy=self.instance_policy,
            max_instances=self.max_instances,
            recommended=False,
            metadata=metadata,
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        return self._config_schema()

    def _config_schema(self) -> RuntimeConfigSchema:
        return RuntimeConfigSchema(
            runtime=self.runtime,
            revision=OPENCODE_CONFIG_SCHEMA_REVISION,
            schema=provider_config.opencode_config_schema(),
            ui_schema={
                "order": [
                    "stateDir",
                    "servicePid",
                    "location",
                    "startupTimeoutMs",
                    "requestTimeoutMs",
                    "maxRestartAttempts",
                    "restartBackoffMs",
                ],
                "stateDir": {"component": "path"},
            },
            defaults=provider_config.default_config_values(),
            metadata={
                "storageMode": "opencode-native",
                "sameSessionWriterLimit": 1,
                "crossProcessWriterExclusion": False,
                "instanceGranularity": "location",
            },
        )

    async def validate_config(self, values: Mapping[str, Any]) -> RuntimeConfig:
        raw = dict(values)
        errors = sorted(
            Draft202012Validator(provider_config.opencode_config_schema()).iter_errors(
                raw
            ),
            key=lambda error: list(error.absolute_path),
        )
        if errors:
            path = "/" + "/".join(str(part) for part in errors[0].absolute_path)
            raise RuntimeInvalidRequestError(
                f"opencode config is invalid at {path or '/'}: {errors[0].message}"
            )
        normalized = provider_config.normalized_config_values(raw)
        result = await self._prober(normalized)
        self._remember(result)
        self._last_values = normalized
        # Offline is temporary, not an invalid configuration. The runtime owns
        # reconnection and re-reads the registration each attempt.
        metadata = dict(result.metadata or {})
        capabilities = provider_config.opencode_capabilities(
            metadata.get("runtimeCapabilities")
        )
        metadata.update(
            {
                "transport": "service-http",
                "readOnly": not capabilities["startTurn"],
                "storageMode": "opencode-native",
                "sameSessionWriterLimit": 1,
                "crossProcessWriterExclusion": False,
                "configured": result.configured,
            }
        )
        schema_info = self._config_schema()
        return RuntimeConfig(
            runtime=self.runtime,
            revision=OPENCODE_CONFIG_SCHEMA_REVISION,
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
        # The same config-derived reader discovery uses, so a custom `stateDir`
        # cannot be visible to one and invisible to the other.
        return OpenCodeServiceRuntime(
            config=config,
            host=host,
            service_reader=provider_config.service_reader(dict(config.values)),
        )

    def resource_claims(
        self,
        config: RuntimeConfig,
    ) -> tuple[RuntimeResourceClaim, ...]:
        registry = str(provider_config.registry_dir(dict(config.values)))
        return (
            RuntimeResourceClaim(
                kind="opencode_service_registration",
                key=_instance_resource_key(dict(config.values)),
                label=f"OpenCode service registration under {registry!r}",
            ),
        )

    def session_source_key(self, config: RuntimeConfig) -> RuntimeSourceKey:
        return RuntimeSourceKey(
            kind="opencode_service",
            key=_instance_resource_key(dict(config.values)),
        )


def _instance_resource_key(values: Mapping[str, Any]) -> str:
    """Registry key narrowed to one running OpenCode instance.

    ``resource_claims``/``session_source_key`` must not collapse every OpenCode
    process sharing a state directory into one identity, so the key is suffixed
    with whichever of ``(servicePid, location)`` are configured (audit M1). With
    neither set the key is the plain registration directory, unchanged. No
    password or other secret ever enters the key.
    """

    parts = [filesystem_resource_key(provider_config.registry_dir(dict(values)))]
    pid = values.get("servicePid")
    if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
        parts.append(f"servicePid={pid}")
    location = values.get("location")
    if isinstance(location, str) and location:
        parts.append(f"location={canonical_path(location)}")
    return "::".join(parts)
