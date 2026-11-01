"""Local Antigravity provider using an ACP bridge."""

from __future__ import annotations

import importlib.util
import os
import sys
from dataclasses import replace
from pathlib import Path

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeProvider,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.errors import RuntimeInvalidRequestError
from connector.runtimes.acp.domain.definitions import AcpError, AgentProfile, LaunchDefinition
from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.runtime import AcpRuntime

from .catalogs import ANTIGRAVITY_PERMISSION_OPTIONS, load_antigravity_model_catalog
from .discovery import discover_antigravity


class AntigravityClient(AgentClient):
    async def start(self, launch: LaunchDefinition, cwd: str) -> dict:
        result = await super().start(launch, cwd)
        self.capabilities["sessionCapabilities"] = {"list": {}, "resume": {}, "close": {}}
        return result


class AntigravityProvider(RuntimeProvider):
    runtime_type = "antigravity"
    display_name = "Antigravity"
    implementation_type = "acp-stdio"
    instance_policy = "multiple"

    async def get_config_schema(self):
        return RuntimeConfigSchema(
            runtime="antigravity",
            revision=1,
            schema={"type": "object", "additionalProperties": False, "properties": {}},
            defaults={},
        )

    async def discover(self):
        launch = discover_antigravity()
        available = launch is not None
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            implementation_type=self.implementation_type,
            instance_policy=self.instance_policy,
            available=available,
            config_schema=await self.get_config_schema(),
            reason=None if available else "需要安装 Antigravity 桌面端或 CLI。",
            capabilities={
                "asyncCreation": True,
                "createAndStartSession": True,
                "startTurn": True,
                "modelCatalog": True,
                "permissionCatalog": True,
            },
            metadata={"nativeHistory": False, "localInstallation": True},
        )

    async def validate_config(self, values):
        if values:
            raise RuntimeInvalidRequestError("Antigravity 暂不支持配置附加参数。")
        schema = await self.get_config_schema()
        return RuntimeConfig(runtime="antigravity", revision=1, values={}, schema=schema.schema)

    async def create_runtime(self, config, host):
        detected = discover_antigravity()
        if detected is None:
            raise AcpError("antigravity_not_installed", "未找到 Antigravity 桌面端或 CLI。")
        config = replace(config, runtime_id=getattr(host, "runtime_id", None) or config.runtime_id)
        environment = (
            ("ANTIGRAVITY_BIN", detected.executable),
            ("PATH", str(Path(detected.executable).parent) + os.pathsep + os.environ.get("PATH", "")),
        )
        launch = LaunchDefinition(
            sys.executable,
            ("-m", "connector.runtimes.antigravity.bridge"),
            "antigravity-bridge-1.0.0",
            environment,
        )
        profile = AgentProfile(
            id="antigravity",
            title="Antigravity",
            permission_options=ANTIGRAVITY_PERMISSION_OPTIONS,
            runtime_capabilities=(
                "catalog.model",
                "catalog.effort",
                "catalog.permission",
            ),
            model_catalog_loader=load_antigravity_model_catalog,
        )
        return AcpRuntime(
            config,
            host,
            profile,
            launch,
            client_factory=AntigravityClient,
        )
