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

from .catalogs import ZCODE_PERMISSION_OPTIONS, load_zcode_model_catalog
from .discovery import discover_zcode, electron_node_exec
from .native_runtime import NativeZcodeRuntime

HISTORY_DB_ENV = "ZCODE_CLI_DB"


def history_db_path() -> Path:
    configured = os.environ.get(HISTORY_DB_ENV, "").strip()
    if configured:
        return Path(configured)
    return Path.home() / ".zcode" / "cli" / "db" / "db.sqlite"


class ZCodeClient(AgentClient):
    async def start(self, launch: LaunchDefinition, cwd: str) -> dict:
        result = await super().start(launch, cwd)
        # zcode-acp 0.9.1 declares these at initialize's top level. The ACP
        # SDK discards that location, although this pinned bridge implements them.
        self.capabilities["sessionCapabilities"] = {"list": {}, "resume": {}, "close": {}}
        # AA 扩展能力：主车道附件由 bridge 落盘后以本机路径写进提示词。
        aa = self.capabilities.setdefault("_meta", {}).setdefault("aa", {})
        aa["capabilities"] = ["runtime.attachment"]
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
                # server 端 create-and-start 按这份快照门控附件。
                "attachments": True,
            },
            metadata={"nativeHistory": True, "localInstallation": True},
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
        env_items = [
            ("ZCODE_CJS", entry),
        ]
        electron_exec = electron_node_exec(entry)
        if electron_exec:
            # 引擎 3.17.1+ 需要 node:sqlite；find_node() 探测失败时用桌面端
            # node-fallback shim（ELECTRON_RUN_AS_NODE 复用 Electron 自带 Node）。
            env_items.append(("ZCODE_NODE_FALLBACK_EXEC_PATH", electron_exec))
        env_items.extend([
            ("ZCODE_ACP_TRACE", "0"),
            ("ZCODE_ACP_APPROVAL_BRIDGE", "0"),
            ("ZCODE_ACP_ENGINE_LOG", os.devnull),
            ("PATH", str(Path(detected.executable).parent) + os.pathsep + os.environ.get("PATH", "")),
        ])
        environment = tuple(env_items)
        launch = LaunchDefinition(sys.executable, ("-m", module_name), "zcode-bridge-0.9.1", environment)
        profile = AgentProfile(
            id="zcode",
            title="ZCode",
            permission_options=ZCODE_PERMISSION_OPTIONS,
            runtime_capabilities=(
                "catalog.model",
                "catalog.effort",
                "catalog.permission",
                "runtime.attachment",
            ),
            model_catalog_loader=load_zcode_model_catalog,
        )
        return NativeZcodeRuntime(
            config,
            host,
            profile,
            launch,
            client_factory=ZCodeClient,
            history_db_path=history_db_path(),
        )
