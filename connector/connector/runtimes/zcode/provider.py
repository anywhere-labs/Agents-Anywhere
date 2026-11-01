"""Local ZCode provider, using a version-pinned ACP bridge."""

from __future__ import annotations

import importlib.util
import os
import sys
from dataclasses import replace
from pathlib import Path

from connector.runtime_protocol import RuntimeConfig, RuntimeConfigSchema, RuntimeProvider, RuntimeTypeDescriptor
from connector.runtime_protocol.errors import RuntimeInvalidRequestError
from connector.runtimes.acp.domain.definitions import AcpError, AgentProfile, LaunchDefinition
from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.runtime import AcpRuntime

from .catalogs import ZCODE_PERMISSION_OPTIONS, load_zcode_model_catalog
from .discovery import discover_zcode


class ZCodeClient(AgentClient):
    async def start(self, launch: LaunchDefinition, cwd: str) -> dict:
        result = await super().start(launch, cwd)
        # zcode-acp 0.9.1 declares these at initialize's top level. The ACP
        # SDK discards that location, although this pinned bridge implements them.
        self.capabilities["sessionCapabilities"] = {"list": {}, "resume": {}, "close": {}}
        return result


class ZCodeProvider(RuntimeProvider):
    runtime_type = "zcode"
    display_name = "ZCode"
    implementation_type = "acp-stdio"
    instance_policy = "multiple"

    async def get_config_schema(self):
        return RuntimeConfigSchema(runtime="zcode", revision=1, schema={
            "type": "object", "additionalProperties": False, "properties": {},
        }, defaults={})

    async def discover(self):
        launch = discover_zcode() if sys.platform == "darwin" else None
        bridge_available = (
            importlib.util.find_spec("connector.runtimes.zcode.bridge") is not None
            or importlib.util.find_spec("zcode_acp") is not None
        )
        available = launch is not None and bridge_available
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type, display_name=self.display_name,
            implementation_type=self.implementation_type, instance_policy=self.instance_policy,
            available=available, config_schema=await self.get_config_schema(),
            reason=None if available else "需要安装 ZCode 桌面版和 Node.js。",
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
            raise RuntimeInvalidRequestError("ZCode 不支持这些配置项。")
        schema = await self.get_config_schema()
        return RuntimeConfig(runtime="zcode", revision=1, values={}, schema=schema.schema)

    async def create_runtime(self, config, host):
        detected = discover_zcode() if sys.platform == "darwin" else None
        module_name = (
            "connector.runtimes.zcode.bridge"
            if importlib.util.find_spec("connector.runtimes.zcode.bridge") is not None
            else "zcode_acp"
        )
        if detected is None or importlib.util.find_spec(module_name) is None:
            raise AcpError("zcode_not_installed", "未找到 ZCode 桌面版、Node.js 或适配器。")
        config = replace(config, runtime_id=getattr(host, "runtime_id", None) or config.runtime_id)
        entry = detected.arguments[0]
        # The bridge's trace is enabled by default and may contain conversation
        # text. Suppress both its trace and engine stderr for private sessions.
        environment = (
            ("ZCODE_CJS", entry),
            ("ZCODE_ACP_TRACE", "0"),
            ("ZCODE_ACP_APPROVAL_BRIDGE", "0"),
            ("ZCODE_ACP_ENGINE_LOG", os.devnull),
            ("PATH", str(Path(detected.executable).parent) + os.pathsep + os.environ.get("PATH", "")),
        )
        launch = LaunchDefinition(sys.executable, ("-m", module_name), "zcode-bridge-0.9.1", environment)
        profile = AgentProfile(
            id="zcode",
            title="ZCode",
            permission_options=ZCODE_PERMISSION_OPTIONS,
            runtime_capabilities=(
                "catalog.model",
                "catalog.effort",
                "catalog.permission",
            ),
            model_catalog_loader=load_zcode_model_catalog,
        )
        return AcpRuntime(config, host, profile, launch, client_factory=ZCodeClient)
