"""Pi's definition: OpenMA's published ACP executable bound to a Pi SDK."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path

from connector.runtime_protocol.errors import RuntimeInvalidRequestError
from connector.runtime_protocol.model_connection import (
    ModelConnectionCapability,
    ModelConnectionMode,
    ModelConnectionUnsupportedError,
    applied_status,
)
from connector.runtimes.custom_models import (
    custom_models_schema,
    normalize_custom_models,
)
from connector.runtimes.model_gateway import (
    model_gateway_from_config,
    model_gateway_schema,
)
from connector.runtimes.runtime_model import (
    runtime_model_from_config,
    runtime_model_schema,
)

from ...domain.agents import AcpAgentDefinition, ConfigSchema
from ...domain.definitions import AcpError, LaunchDefinition
from ...infrastructure.npm import install_npm_runtime
from .adapter import prepare_adapter
from .dialect import GUARD, PiDialect
from .environment import DEPENDENCIES, npm_root
from .installation import (
    PiInstallation,
    agent_directory,
    history_directories,
    installation_identity,
    probe_sdk,
    resolve_local,
)
from .settings import prepare_settings, private_json

LOCAL_MODE_REASON = "本机模式使用 Pi 自己的模型配置，不能同时填写模型网关；要用网关请切换到 AA 受管环境。"

# Only the AA-managed environment takes a model connection: it writes a private
# models.json for the gateway. Local Pi keeps its own models and credentials.
MODEL_CONNECTION = ModelConnectionCapability(
    maturity="beta",
    protocols=("openai_chat",),
    scope="instance",
    apply="restart",
    catalog_auto=True,
    catalog_manual=True,
    mode_field="executionMode",
    # Local Pi has no runtime-level catalog to choose from; only managed takes it.
    model_field="model",
    modes=(
        ModelConnectionMode("managed", True),
        ModelConnectionMode("local", False, LOCAL_MODE_REASON),
        ModelConnectionMode("auto", False, LOCAL_MODE_REASON),
    ),
)

CONFIG_SCHEMA = ConfigSchema(
    schema={
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "executionMode": {
                "type": "string",
                "title": "运行环境",
                "enum": ["auto", "local", "managed"],
                "enumNames": ["优先本机 Pi", "本机 Pi", "AA 受管环境"],
            },
            "cliPath": {
                "type": "string",
                "title": "本机 pi 路径（可选）",
                "maxLength": 4096,
            },
            "agentDir": {
                "type": "string",
                "title": "Pi 配置目录（可选）",
                "maxLength": 4096,
            },
            "historyDirs": {
                "type": "array",
                "title": "额外历史目录",
                "maxItems": 32,
                "items": {"type": "string", "minLength": 1, "maxLength": 4096},
            },
            "modelGateway": model_gateway_schema(),
            "customModels": custom_models_schema(),
            "model": runtime_model_schema(),
        },
    },
    ui_schema={
        "order": [
            "executionMode",
            "cliPath",
            "agentDir",
            "historyDirs",
            "modelGateway",
            "customModels",
        ],
        "fields": {
            "modelGateway": {"component": "modelGateway"},
            "customModels": {"component": "customModels"},
        },
    },
    defaults={"executionMode": "auto", "customModels": [], "historyDirs": []},
)


def source_changed(previous: dict | None, current: dict) -> bool:
    """Pi, Node and adapter upgrades are re-checked on every launch.

    Only a different mode or native configuration directory makes this a
    different source; an explicit managed configuration edit rotates its
    private directory.
    """
    if not previous:
        return False
    fixed = ("mode",) if current["mode"] == "managed" else ("mode", "agentDir")
    return any(previous.get(key) != current[key] for key in fixed)


def normalize_config(values, normalized: dict) -> dict:
    # Old saved gateway configurations retain their isolated source.
    if "executionMode" not in values and values.get("modelGateway"):
        normalized["executionMode"] = "managed"
    # A connection the chosen mode would not use is rejected, not ignored.
    if normalized.get("modelGateway") and normalized["executionMode"] != "managed":
        raise ModelConnectionUnsupportedError(LOCAL_MODE_REASON)
    if normalized.get("modelGateway"):
        normalized["modelGateway"] = model_gateway_from_config(
            normalized["modelGateway"]
        ).to_config_values()
    if normalized["executionMode"] == "managed" and not normalized.get("modelGateway"):
        raise RuntimeInvalidRequestError(
            "受管环境需要填写模型网关；已有本机 Pi 请使用本机模式。"
        )
    normalized["customModels"] = normalize_custom_models(normalized.get("customModels"))
    if normalized.get("model") is not None and normalized["executionMode"] != "managed":
        raise ModelConnectionUnsupportedError(LOCAL_MODE_REASON)
    if (model := runtime_model_from_config(normalized)) is not None:
        normalized["model"] = model.to_config_values()
    return normalized


def model_connection_status(config):
    return applied_status(MODEL_CONNECTION, config.values, mode=config.values.get("executionMode"))


@dataclass(frozen=True)
class PiLayout:
    managed: bool
    settings_root: Path
    agent_dir: Path
    permission_file: Path


def layout(context) -> PiLayout:
    values = context.config.values
    # A cancelled preparation must never overwrite a newer gateway's files.
    revision = hashlib.sha256(json.dumps(dict(values), sort_keys=True).encode()).hexdigest()[:24]
    settings_root = context.root / "configurations" / revision
    managed = (
        values.get("executionMode", "managed" if values.get("modelGateway") else "auto")
        == "managed"
    )
    agent_dir = settings_root / "pi" if managed else agent_directory(dict(values))
    permission_file = (
        agent_dir / "aa-permissions.json" if managed else context.root / "aa-permissions.json"
    )
    return PiLayout(managed, settings_root, agent_dir, permission_file)


def dialect(context) -> PiDialect:
    paths = layout(context)
    return PiDialect(agent_dir=paths.agent_dir, permission_file=paths.permission_file)


def prepare_launch(context):
    config, host, root = context.config, context.host, context.root
    paths = layout(context)
    managed, settings_root, agent_dir = paths.managed, paths.settings_root, paths.agent_dir

    async def launch() -> LaunchDefinition:
        installation = (
            None if managed else await asyncio.to_thread(resolve_local, dict(config.values))
        )
        if installation:
            # Reject an unusable local SDK before downloading the adapter.
            await asyncio.to_thread(probe_sdk, installation)
        node, entry = await asyncio.to_thread(
            install_npm_runtime,
            npm_root(host.runtime_kv.path.parent / "npm-runtimes"),
            DEPENDENCIES,
            "@openma/pi-acp/dist/bin.js",
        )
        if managed:
            await asyncio.to_thread(prepare_settings, settings_root, dict(config.values))
            sdk = entry.parents[3] / "@earendil-works/pi-coding-agent"
            installation = PiInstallation(
                entry, node, sdk, DEPENDENCIES["@earendil-works/pi-coding-agent"]
            )
            await asyncio.to_thread(probe_sdk, installation)
        provenance = await asyncio.to_thread(installation_identity, installation)
        adapter_version = json.loads(
            (entry.parent.parent / "package.json").read_text(encoding="utf-8")
        )["version"]
        adapter_dependencies = await asyncio.to_thread(
            installation_identity,
            PiInstallation(entry, node, entry.parent.parent, adapter_version),
        )
        patched, adapter = await asyncio.to_thread(
            prepare_adapter,
            entry,
            installation.sdk,
            host.runtime_kv.path.parent / "pi-adapters",
        )
        identity = {
            "installation": provenance,
            "adapter": adapter,
            "adapterDependencies": adapter_dependencies,
            "guardSha256": hashlib.sha256(GUARD.read_bytes()).hexdigest(),
            "agentDir": str(agent_dir),
            "mode": "managed" if managed else "local",
        }
        previous = root / "execution-source.json"
        old_identity = (
            json.loads(previous.read_text(encoding="utf-8")) if previous.exists() else None
        )
        if source_changed(old_identity, identity):
            raise AcpError(
                "pi_execution_source_changed",
                "此 Pi 实例的运行模式或配置目录已变化；请恢复原配置，或新建 Pi 实例。",
            )
        private_json(previous, identity)
        env = [
            ("PI_CODING_AGENT_DIR", str(agent_dir)),
            ("AA_PI_PERMISSIONS_FILE", str(paths.permission_file)),
            ("AA_PI_GUARD_DIGEST", "sha256:" + identity["guardSha256"]),
            ("AA_PI_GUARD", str(GUARD)),
            ("PATH", str(installation.node.parent) + os.pathsep + os.environ.get("PATH", "")),
        ]
        if managed:
            env.append(("AA_PI_GATEWAY_KEY", config.values["modelGateway"]["apiKey"]))
        args = [str(patched), "--agent-dir", str(agent_dir), "--quiet-startup", "--no-delegation"]
        if managed:
            args.extend(["--session-dir", str(root / "sessions")])
        return LaunchDefinition(
            str(installation.node),
            tuple(args),
            "openma-pi-acp-" + adapter["version"],
            environment=tuple(env),
        )

    return launch


def runtime(context, client_factory):
    """Pi installs in the background; local Pi adds native history browsing and handoff."""
    from .native_runtime import NativePiRuntime
    from .runtime import ManagedPiRuntime

    paths = layout(context)
    launch = prepare_launch(context)
    runtime_class = ManagedPiRuntime if paths.managed else NativePiRuntime
    instance = runtime_class(
        context.config,
        context.host,
        context.definition.profile,
        LaunchDefinition(str(context.root / ".pending-node"), (), "openma-pi-acp"),
        prepare_launch=launch,
        client_factory=client_factory,
        **(
            {"settings_dir": paths.agent_dir}
            if paths.managed
            else {"history_roots": history_directories(dict(context.config.values), paths.agent_dir)}
        ),
    )
    if paths.managed:

        async def validated_launch():
            definition = await launch()
            instance.launch = definition
            instance.app.launch = definition
            return definition

        async def session_launch(_session_id):
            return await validated_launch()

        instance.app.launch_for_preparation = validated_launch
        instance.app.launch_for_session = session_launch
    return instance


PI = AcpAgentDefinition(
    runtime_type="pi",
    display_name="Pi",
    config_schema=CONFIG_SCHEMA,
    normalize_config=normalize_config,
    permission_options=(
        ("ask", "写入与命令审批"),
        ("ask_all", "全部工具审批"),
        ("readonly", "只读"),
    ),
    # The dialect verifies AA's permission extension before exposing a writable session.
    required_guarantees=frozenset({"managed_tool_permissions"}),
    metadata={
        "managedInstallation": True,
        "localInstallation": True,
        "nativeHistory": True,
        "package": "@openma/pi-acp",
    },
    maturity="beta",
    model_connection=MODEL_CONNECTION,
    model_connection_status=model_connection_status,
    dialect=dialect,
    prepare_launch=prepare_launch,
    runtime=runtime,
)
