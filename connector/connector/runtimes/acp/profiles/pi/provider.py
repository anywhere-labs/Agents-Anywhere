"""Pi identity and AA configuration, using OpenMA's published ACP executable."""
from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import replace
from functools import partial

from jsonschema import Draft202012Validator

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeProvider,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.errors import RuntimeInvalidRequestError
from connector.runtimes.custom_models import (
    custom_models_schema,
    normalize_custom_models,
)
from connector.runtimes.model_gateway import (
    model_gateway_from_config,
    model_gateway_schema,
)

from ...domain.definitions import LaunchDefinition
from ...infrastructure.npm import install_npm_runtime
from .client import PiClient
from .profile import PI_PROFILE
from .runtime import ManagedPiRuntime
from .settings import prepare_settings

# Pin the compatible dependency set for the managed OpenMA executable.
DEPENDENCIES = {
    "@openma/pi-acp": "0.1.8",
    "@earendil-works/pi-coding-agent": "1.4.0",
    "@earendil-works/pi-ai": "1.4.0",
    "@earendil-works/pi-agent-core": "1.4.0",
}


class PiProvider(RuntimeProvider):
    runtime_type = "pi"
    display_name = "Pi"
    implementation_type = "acp-stdio"
    instance_policy = "multiple"

    def __init__(self):
        self.profile = PI_PROFILE

    async def get_config_schema(self):
        return RuntimeConfigSchema(
            runtime="pi", revision=1,
            schema={"type": "object", "additionalProperties": False,
                    "required": ["modelGateway"],
                    "properties": {"modelGateway": model_gateway_schema(), "customModels": custom_models_schema()}},
            ui_schema={"order": ["modelGateway", "customModels"], "fields": {
                "modelGateway": {"component": "modelGateway"},
                "customModels": {"component": "customModels"},
            }},
            defaults={"customModels": []},
        )

    async def discover(self):
        return RuntimeTypeDescriptor(
            runtime_type="pi", display_name="Pi", available=True,
            implementation_type="acp-stdio", instance_policy="multiple",
            config_schema=await self.get_config_schema(),
            capabilities={"workspacePreparation": True, "asyncCreation": True, "attachments": True},
            metadata={"managedInstallation": True, "package": "@openma/pi-acp"},
        )

    async def validate_config(self, values):
        schema = await self.get_config_schema()
        errors = list(Draft202012Validator(schema.schema).iter_errors(dict(values)))
        if errors:
            raise RuntimeInvalidRequestError(errors[0].message)
        normalized = {**schema.defaults, **values}
        normalized["modelGateway"] = model_gateway_from_config(normalized["modelGateway"]).to_config_values()
        normalized["customModels"] = normalize_custom_models(normalized.get("customModels"))
        return RuntimeConfig(runtime="pi", revision=1, values=normalized,
                             schema=schema.schema, ui_schema=schema.ui_schema)

    async def create_runtime(self, config, host):
        config = replace(config, runtime_id=getattr(host, "runtime_id", None) or config.runtime_id)
        namespace = hashlib.sha256(f"{host.session_namespace}:{config.runtime_id}".encode()).hexdigest()
        root = host.runtime_kv.path.parent / "acp" / namespace
        # A cancelled preparation must never overwrite a newer gateway's files.
        revision = hashlib.sha256(json.dumps(dict(config.values), sort_keys=True).encode()).hexdigest()[:24]
        settings_root = root / "configurations" / revision
        agent_dir = settings_root / "pi"

        async def prepare_launch():
            node, entry = await asyncio.to_thread(install_npm_runtime, host.runtime_kv.path.parent / "npm-runtimes", DEPENDENCIES, "@openma/pi-acp/dist/bin.js")
            await asyncio.to_thread(prepare_settings, settings_root, dict(config.values))
            return LaunchDefinition(str(node), (str(entry), "--agent-dir", str(agent_dir),
                "--session-dir", str(root / "sessions"), "--quiet-startup", "--no-delegation"),
                "openma-pi-acp-0.1.8", environment=(("PI_CODING_AGENT_DIR", str(agent_dir)),
                    ("AA_PI_GATEWAY_KEY", config.values["modelGateway"]["apiKey"])))

        return ManagedPiRuntime(config, host, self.profile,
            LaunchDefinition(str(root / ".pending-node"), (), "openma-pi-acp-0.1.8"),
            prepare_launch=prepare_launch, client_factory=partial(PiClient, agent_dir=agent_dir))


def pi_acp_provider():
    return PiProvider()
