from __future__ import annotations

import sys
from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeInstancePolicy,
    RuntimeProvider,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.antigravity import discovery, provider_config
from connector.runtimes.antigravity.runtime import AntigravityRuntime


class AntigravityProvider(RuntimeProvider):
    @property
    def runtime(self) -> str:
        return "antigravity"

    @property
    def runtime_type(self) -> str:
        return "antigravity"

    @property
    def display_name(self) -> str:
        return "Antigravity"

    @property
    def description(self) -> str:
        return "Google Antigravity Agent Runtime"

    @property
    def instance_policy(self) -> RuntimeInstancePolicy:
        return "single"

    @property
    def max_instances(self) -> int:
        return 1

    async def discover(self) -> RuntimeTypeDescriptor:
        check = discovery.check_antigravity_installed()
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            description=self.description,
            available=check.get("installed", False),
            capabilities={
                "modelCatalog": True,
                "permissionCatalog": False,
                "sessionDiscovery": True,
                "sessionSnapshot": True,
                "sessionState": True,
                "sessionNotices": True,
                "createAndStartSession": True,
                "startTurn": True,
                "steerTurn": False,
                "interruptTurn": False,
                "commands": False,
                "interactions": False,
                "attachments": False,
                "ipc": False,
            },
            reason=None if check.get("installed") else "Antigravity not found on system",
            config_schema=await self.get_config_schema(),
            instance_policy=self.instance_policy,
            max_instances=self.max_instances,
            metadata={
                "configured": True,
                "status": check,
                "platform": sys.platform,
            },
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        schema = provider_config.antigravity_config_schema()
        return RuntimeConfigSchema(
            runtime=self.runtime,
            revision=1,
            schema=schema,
            ui_schema={
                "order": ["defaultModel", "agentapiPath", "dataDir"],
            },
            defaults={
                "defaultModel": "flash",
                "agentapiPath": str(provider_config.DEFAULT_AGENTAPI_PATH),
                "dataDir": str(provider_config.DEFAULT_ANTIGRAVITY_DIR),
            },
        )

    async def validate_config(
        self,
        values: Mapping[str, Any],
    ) -> RuntimeConfig:
        normalized = dict(values)
        if "defaultModel" not in normalized:
            normalized["defaultModel"] = "flash"
        schema = (await self.get_config_schema()).schema
        return RuntimeConfig(
            runtime=self.runtime,
            revision=1,
            values=normalized,
            schema=schema,
            metadata=discovery.check_antigravity_installed(),
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> AgentRuntime:
        return AntigravityRuntime(config=config, host=host)
