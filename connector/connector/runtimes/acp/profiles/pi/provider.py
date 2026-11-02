"""Pi identity and AA configuration, using OpenMA's published ACP executable."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from dataclasses import replace
from functools import partial
from pathlib import Path

from jsonschema import Draft202012Validator

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeProvider,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.errors import RuntimeInvalidRequestError
from connector.runtime_protocol.model_connection import (
    ModelConnectionCapability,
    ModelConnectionMode,
    ModelConnectionStatus,
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

from ...domain.definitions import AcpError, LaunchDefinition
from ...infrastructure.npm import install_npm_runtime
from .adapter import prepare_adapter
from .client import PiClient
from .installation import (
    PiInstallation,
    agent_directory,
    history_directories,
    installation_identity,
    probe_sdk,
    resolve_local,
)
from .native_runtime import NativePiRuntime
from .profile import PI_PROFILE
from .runtime import ManagedPiRuntime
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
    modes=(
        ModelConnectionMode("managed", True),
        ModelConnectionMode("local", False, LOCAL_MODE_REASON),
        ModelConnectionMode("auto", False, LOCAL_MODE_REASON),
    ),
)

# The managed environment keeps a verified SDK; the adapter follows its 0.1.x
# releases because every patch anchor is re-checked before use.
DEPENDENCIES = {
    "@openma/pi-acp": "^0.1.8",
    "@earendil-works/pi-coding-agent": "1.4.0",
    "@earendil-works/pi-ai": "1.4.0",
    "@earendil-works/pi-agent-core": "1.4.0",
}


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


class PiProvider(RuntimeProvider):
    runtime_type = "pi"
    display_name = "Pi"
    implementation_type = "acp-stdio"
    instance_policy = "multiple"

    def __init__(self):
        self.profile = PI_PROFILE

    async def get_config_schema(self):
        return RuntimeConfigSchema(
            runtime="pi",
            revision=1,
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

    async def discover(self):
        return RuntimeTypeDescriptor(
            runtime_type="pi",
            display_name="Pi",
            available=True,
            implementation_type="acp-stdio",
            instance_policy="multiple",
            maturity="beta",
            model_connection=MODEL_CONNECTION,
            config_schema=await self.get_config_schema(),
            capabilities={
                "workspacePreparation": True,
                "asyncCreation": True,
                "attachments": True,
            },
            metadata={
                "managedInstallation": True,
                "localInstallation": True,
                "nativeHistory": True,
                "package": "@openma/pi-acp",
            },
        )

    async def validate_config(self, values):
        schema = await self.get_config_schema()
        errors = list(Draft202012Validator(schema.schema).iter_errors(dict(values)))
        if errors:
            # jsonschema quotes the offending value, which may be the API key.
            error = errors[0]
            location = "/".join(str(part) for part in error.absolute_path) or "配置"
            raise RuntimeInvalidRequestError(f"{location} 不符合 {error.validator} 规则")
        normalized = {**schema.defaults, **values}
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
        if normalized["executionMode"] == "managed" and not normalized.get(
            "modelGateway"
        ):
            raise RuntimeInvalidRequestError(
                "受管环境需要填写模型网关；已有本机 Pi 请使用本机模式。"
            )
        normalized["customModels"] = normalize_custom_models(
            normalized.get("customModels")
        )
        return RuntimeConfig(
            runtime="pi",
            revision=1,
            values=normalized,
            schema=schema.schema,
            ui_schema=schema.ui_schema,
        )

    def model_connection_status(self, config) -> ModelConnectionStatus:
        mode = config.values.get("executionMode")
        return applied_status(MODEL_CONNECTION, config.values, mode=mode)

    async def create_runtime(self, config, host):
        config = replace(
            config, runtime_id=getattr(host, "runtime_id", None) or config.runtime_id
        )
        namespace = hashlib.sha256(
            f"{host.session_namespace}:{config.runtime_id}".encode()
        ).hexdigest()
        root = host.runtime_kv.path.parent / "acp" / namespace
        # A cancelled preparation must never overwrite a newer gateway's files.
        revision = hashlib.sha256(
            json.dumps(dict(config.values), sort_keys=True).encode()
        ).hexdigest()[:24]
        settings_root = root / "configurations" / revision
        managed = (
            config.values.get(
                "executionMode",
                "managed" if config.values.get("modelGateway") else "auto",
            )
            == "managed"
        )
        agent_dir = (
            settings_root / "pi" if managed else agent_directory(dict(config.values))
        )
        permission_file = (
            agent_dir / "aa-permissions.json"
            if managed
            else root / "aa-permissions.json"
        )

        async def prepare_launch():
            installation = (
                None
                if managed
                else await asyncio.to_thread(resolve_local, dict(config.values))
            )
            if installation:
                # Reject an unusable local SDK before downloading the adapter.
                await asyncio.to_thread(probe_sdk, installation)
            node, entry = await asyncio.to_thread(
                install_npm_runtime,
                host.runtime_kv.path.parent / "npm-runtimes",
                DEPENDENCIES,
                "@openma/pi-acp/dist/bin.js",
            )
            if managed:
                await asyncio.to_thread(
                    prepare_settings, settings_root, dict(config.values)
                )
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
                "guardSha256": hashlib.sha256(
                    Path(__file__).with_name("permissions.mjs").read_bytes()
                ).hexdigest(),
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
                ("AA_PI_PERMISSIONS_FILE", str(permission_file)),
                ("AA_PI_GUARD_DIGEST", "sha256:" + identity["guardSha256"]),
                (
                    "AA_PI_GUARD",
                    str(Path(__file__).with_name("permissions.mjs").resolve()),
                ),
                (
                    "PATH",
                    str(installation.node.parent)
                    + os.pathsep
                    + os.environ.get("PATH", ""),
                ),
            ]
            if managed:
                env.append(
                    ("AA_PI_GATEWAY_KEY", config.values["modelGateway"]["apiKey"])
                )
            args = [
                str(patched),
                "--agent-dir",
                str(agent_dir),
                "--quiet-startup",
                "--no-delegation",
            ]
            if managed:
                args.extend(["--session-dir", str(root / "sessions")])
            return LaunchDefinition(
                str(installation.node),
                tuple(args),
                "openma-pi-acp-" + adapter["version"],
                environment=tuple(env),
            )

        runtime_class = ManagedPiRuntime if managed else NativePiRuntime
        runtime = runtime_class(
            config,
            host,
            self.profile,
            LaunchDefinition(str(root / ".pending-node"), (), "openma-pi-acp"),
            prepare_launch=prepare_launch,
            client_factory=partial(
                PiClient, agent_dir=agent_dir, permission_file=permission_file
            ),
            **(
                {"history_roots": history_directories(dict(config.values), agent_dir)}
                if not managed
                else {}
            ),
        )
        if managed:

            async def validated_launch():
                launch = await prepare_launch()
                runtime.launch = launch
                runtime.app.launch = launch
                return launch

            async def session_launch(_session_id):
                return await validated_launch()

            runtime.app.launch_for_preparation = validated_launch
            runtime.app.launch_for_session = session_launch
        return runtime


def pi_acp_provider():
    return PiProvider()
