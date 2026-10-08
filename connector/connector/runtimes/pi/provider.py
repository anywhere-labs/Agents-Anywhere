"""Pi runtime provider: discovery, configuration, and runtime construction."""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import (
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
from connector.runtimes.pi.config import (
    CONFIG_SCHEMA_REVISION,
    default_config_values,
    normalized_config_values,
    pi_config_schema,
    probe_pi_version,
)
from connector.runtimes.pi.runtime import PiRuntime

logger = logging.getLogger(__name__)


class PiProvider(RuntimeProvider):
    """Registers the Pi coding agent as an Agents Anywhere runtime type."""

    @property
    def runtime_type(self) -> str:
        return "pi"

    @property
    def display_name(self) -> str:
        return "Pi Coding Agent"

    @property
    def description(self) -> str:
        return "Pi coding agent driven over `pi --mode rpc`"

    @property
    def implementation_type(self) -> str:
        return "local-process"

    @property
    def instance_policy(self) -> str:
        return "multiple"

    @property
    def max_instances(self) -> int | None:
        return None

    async def discover(self) -> RuntimeTypeDescriptor:
        values = default_config_values()
        version = await probe_pi_version(str(values["executablePath"]))
        available = version is not None
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            description=self.description,
            implementation_type=self.implementation_type,
            available=available,
            reason=None if available else "pi executable was not found on PATH",
            capabilities=pi_capabilities(),
            config_schema=self._config_schema(),
            instance_policy="multiple",
            metadata={
                "protocolVersion": "1.0",
                "storageMode": "pi-native",
                "executable": values["executablePath"],
                "version": version,
            },
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        return self._config_schema()

    async def validate_config(self, values: Mapping[str, Any]) -> RuntimeConfig:
        normalized = normalized_config_values(values)
        executable = str(normalized["executablePath"])
        version = await probe_pi_version(executable)
        if version is None:
            raise RuntimeInvalidRequestError(
                f"pi executable was not found or failed to start: {executable!r}"
            )
        schema = self._config_schema()
        return RuntimeConfig(
            runtime=self.runtime,
            revision=CONFIG_SCHEMA_REVISION,
            values=normalized,
            schema=schema.schema,
            ui_schema=schema.ui_schema,
            metadata={
                "protocolVersion": "1.0",
                "storageMode": "pi-native",
                "executable": executable,
                "version": version,
            },
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> PiRuntime:
        return PiRuntime(config=config, host=host)

    def resource_claims(
        self,
        config: RuntimeConfig,
    ) -> tuple[RuntimeResourceClaim, ...]:
        values = normalized_config_values(dict(config.values))
        sessions_dir = str(values["sessionsDir"])
        return (
            RuntimeResourceClaim(
                kind="pi_sessions_dir",
                key=filesystem_resource_key(sessions_dir),
                label=f"Pi sessions {sessions_dir!r}",
            ),
        )

    def session_source_key(self, config: RuntimeConfig) -> RuntimeSourceKey:
        values = normalized_config_values(dict(config.values))
        return RuntimeSourceKey(
            kind="pi_sessions_dir",
            key=filesystem_resource_key(str(values["sessionsDir"])),
        )

    def _config_schema(self) -> RuntimeConfigSchema:
        return RuntimeConfigSchema(
            runtime=self.runtime,
            revision=CONFIG_SCHEMA_REVISION,
            schema=pi_config_schema(),
            ui_schema={
                "order": [
                    "executablePath",
                    "sessionsDir",
                    "defaultCwd",
                    "requestTimeoutMs",
                    "idleTimeoutSeconds",
                    "permissionMode",
                ],
                "executablePath": {"component": "path"},
                "sessionsDir": {"component": "path"},
                "defaultCwd": {"component": "path"},
            },
            defaults=default_config_values(),
            metadata={"storageMode": "pi-native"},
        )


def pi_capabilities() -> dict[str, bool]:
    return {
        "modelCatalog": True,
        "permissionCatalog": True,
        "sessionDiscovery": True,
        "sessionSnapshot": True,
        "sessionState": True,
        "sessionNotices": True,
        "createAndStartSession": True,
        "startTurn": True,
        "steerTurn": True,
        "interruptTurn": True,
        "commands": True,
        "interactions": True,
        "attachments": True,
        "ipc": True,
    }
