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
    RuntimeProvider,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.errors import RuntimeUnavailableError
from connector.runtime_protocol.host import RuntimeHostClient

from ...domain.definitions import LaunchDefinition
from ...runtime import AcpRuntime
from .client import CommandCodeClient
from .installation import installation_metadata, resolve_command_code
from .profile import COMMAND_CODE_PROFILE
from .provider_config import (
    COMMAND_CODE_CONFIG_SCHEMA_REVISION,
    command_code_capabilities,
    command_code_config_schema,
)


class CommandCodeProvider(RuntimeProvider):
    runtime_type = "commandcode"
    display_name = "Command Code"
    description = "Command Code coding agent (ACP over stdio)"
    implementation_type = "acp-stdio"
    instance_policy = "single"

    async def get_config_schema(self) -> RuntimeConfigSchema:
        return RuntimeConfigSchema(
            runtime=self.runtime_type,
            revision=COMMAND_CODE_CONFIG_SCHEMA_REVISION,
            schema=command_code_config_schema(),
            ui_schema={
                "order": ["cliPath"],
                "cliPath": {"component": "path"},
            },
            defaults={"cliPath": ""},
        )

    async def discover(self) -> RuntimeTypeDescriptor:
        metadata: dict[str, Any] = {
            "provider": "command-code",
            "platform": sys.platform,
        }
        try:
            installation = resolve_command_code({"cliPath": ""})
        except RuntimeUnavailableError as error:
            metadata["binary"] = {"found": False, "reason": str(error)}
        else:
            metadata["binary"] = {
                "found": True,
                **installation_metadata(installation),
            }
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            description=self.description,
            available=True,
            implementation_type=self.implementation_type,
            config_schema=await self.get_config_schema(),
            capabilities=command_code_capabilities(),
            instance_policy=self.instance_policy,
            max_instances=self.max_instances,
            metadata=metadata,
        )

    async def validate_config(self, values: Mapping[str, Any]) -> RuntimeConfig:
        raw_values = dict(values)
        schema_info = await self.get_config_schema()
        errors = sorted(
            Draft202012Validator(schema_info.schema).iter_errors(raw_values),
            key=lambda error: list(error.absolute_path),
        )
        if errors:
            path = "/" + "/".join(str(part) for part in errors[0].absolute_path)
            raise RuntimeInvalidRequestError(
                f"command code config is invalid at {path or '/'}: "
                f"{errors[0].message}"
            )
        cli_path = raw_values.get("cliPath")
        if not isinstance(cli_path, str):
            cli_path = ""
        installation = resolve_command_code({"cliPath": cli_path})
        return RuntimeConfig(
            runtime=self.runtime_type,
            revision=schema_info.revision,
            values={"cliPath": cli_path.strip()},
            schema=schema_info.schema,
            ui_schema=schema_info.ui_schema,
            metadata={
                "binary": installation_metadata(installation),
                "platform": sys.platform,
            },
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        installation = resolve_command_code(dict(config.values))
        launch = LaunchDefinition(
            executable=installation.executable,
            arguments=(
                *installation.arguments,
                "--no-auto-update",
                "acp",
            ),
            release_id=f"command-code-{installation.version}",
            environment=installation.environment,
        )
        return AcpRuntime(
            config,
            host,
            COMMAND_CODE_PROFILE,
            launch,
            client_factory=CommandCodeClient,
        )


def command_code_acp_provider() -> CommandCodeProvider:
    return CommandCodeProvider()
