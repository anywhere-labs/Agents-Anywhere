from __future__ import annotations

import shutil
import sys
from collections.abc import Mapping
from pathlib import Path
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
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.oar import provider_config
from connector.runtimes.oar.runtime import OarRuntime


class OarProvider(RuntimeProvider):
    @property
    def runtime_type(self) -> str:
        return "oar"

    @property
    def display_name(self) -> str:
        return "OAR (Pi)"

    @property
    def description(self) -> str:
        return "Pi through the Open Agent Runtime sidecar"

    @property
    def implementation_type(self) -> str:
        return "oar-sidecar"

    async def discover(self) -> RuntimeTypeDescriptor:
        node = shutil.which("node")
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            description=self.description,
            implementation_type=self.implementation_type,
            available=node is not None,
            reason=None if node else "Node.js is not installed",
            capabilities={
                "session.send_message": True,
                "session.interrupt": True,
                "session.steer": True,
                "runtime.config": True,
            },
            config_schema=await self.get_config_schema(),
            metadata={"node": node, "platform": sys.platform},
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        return RuntimeConfigSchema(
            runtime=self.runtime_type,
            revision=provider_config.OAR_CONFIG_SCHEMA_REVISION,
            schema=provider_config.config_schema(),
            ui_schema={"order": ["nodeExecutable", "sidecarPath", "defaultModel"], "nodeExecutable": {"component": "path"}, "sidecarPath": {"component": "path"}},
            defaults=provider_config.defaults(),
        )

    async def validate_config(self, values: Mapping[str, Any]) -> RuntimeConfig:
        normalized = provider_config.normalized(dict(values))
        errors = sorted(Draft202012Validator(provider_config.config_schema()).iter_errors(normalized), key=lambda error: list(error.absolute_path))
        if errors:
            raise RuntimeInvalidRequestError(errors[0].message)
        if shutil.which(str(normalized["nodeExecutable"])) is None and not str(normalized["nodeExecutable"]).endswith("/node"):
            raise RuntimeInvalidRequestError("Node.js executable is not available")
        sidecar = Path(str(normalized["sidecarPath"]))
        if not (sidecar / "index.mjs").is_file():
            raise RuntimeInvalidRequestError("OAR sidecar is not installed")
        schema = await self.get_config_schema()
        return RuntimeConfig(runtime=self.runtime_type, revision=schema.revision, values=normalized, schema=schema.schema, ui_schema=schema.ui_schema, metadata={"platform": sys.platform})

    async def create_runtime(self, config: RuntimeConfig, host: RuntimeHostClient) -> AgentRuntime:
        return OarRuntime(config=config, host=host)
