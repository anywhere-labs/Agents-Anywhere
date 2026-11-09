"""Hermes identity and AA configuration, using the local ``hermes acp`` server."""

from __future__ import annotations

import asyncio
from dataclasses import replace

from jsonschema import Draft202012Validator

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeProvider,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.errors import RuntimeInvalidRequestError

from ...domain.definitions import LaunchDefinition
from ...runtime import AcpRuntime
from .client import HermesClient
from .installation import prepare_launch
from .profile import HERMES_PROFILE


class HermesProvider(RuntimeProvider):
    runtime_type = "hermes"
    display_name = "Hermes"
    implementation_type = "acp-stdio"
    instance_policy = "multiple"

    def __init__(self):
        self.profile = HERMES_PROFILE

    async def get_config_schema(self):
        return RuntimeConfigSchema(
            runtime="hermes",
            revision=1,
            schema={
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "cliPath": {
                        "type": "string",
                        "title": "本机 hermes 路径（可选）",
                        "maxLength": 4096,
                    },
                    "hermesHome": {
                        "type": "string",
                        "title": "Hermes 配置目录（可选）",
                        "maxLength": 4096,
                    },
                },
            },
            ui_schema={"order": ["cliPath", "hermesHome"], "fields": {}},
            defaults={},
        )

    async def discover(self):
        return RuntimeTypeDescriptor(
            runtime_type="hermes",
            display_name="Hermes",
            available=True,
            implementation_type="acp-stdio",
            instance_policy="multiple",
            config_schema=await self.get_config_schema(),
            capabilities={
                "workspacePreparation": True,
                "asyncCreation": True,
                "attachments": True,
            },
            metadata={"localInstallation": True, "nativeHistory": False},
        )

    async def validate_config(self, values):
        schema = await self.get_config_schema()
        errors = list(Draft202012Validator(schema.schema).iter_errors(dict(values)))
        if errors:
            raise RuntimeInvalidRequestError(errors[0].message)
        return RuntimeConfig(
            runtime="hermes",
            revision=1,
            values={**schema.defaults, **values},
            schema=schema.schema,
            ui_schema=schema.ui_schema,
        )

    async def create_runtime(self, config, host):
        config = replace(
            config, runtime_id=getattr(host, "runtime_id", None) or config.runtime_id
        )
        runtime = AcpRuntime(
            config,
            host,
            self.profile,
            LaunchDefinition("hermes", ("acp",), "hermes"),
            client_factory=HermesClient,
        )

        async def validated_launch():
            launch = await asyncio.to_thread(prepare_launch, dict(config.values))
            runtime.launch = launch
            runtime.app.launch = launch
            return launch

        async def session_launch(_session_id):
            return await validated_launch()

        runtime.app.launch_for_preparation = validated_launch
        runtime.app.launch_for_session = session_launch
        return runtime


def hermes_acp_provider():
    return HermesProvider()
