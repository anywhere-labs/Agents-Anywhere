from __future__ import annotations

import sys
from typing import Any

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeProvider,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.cli_headless import catalogs
from connector.runtimes.cli_headless.discovery import (
    codebuddy_available,
    minimax_available,
)
from connector.runtimes.cli_headless.provider_config import (
    CAPABILITIES,
    CONFIG_SCHEMA_REVISION,
    codebuddy_argv,
    minimax_acp_command,
    minimax_argv,
    shared_config_schema,
    with_default_model,
)
from connector.runtimes.cli_headless.runtime import HeadlessCliRuntime, HeadlessCliSpec


class HeadlessCliProvider(RuntimeProvider):
    """Provider for one headless CLI kernel described by a HeadlessCliSpec."""

    def __init__(self, spec: HeadlessCliSpec) -> None:
        self._spec = spec

    @property
    def runtime_type(self) -> str:
        return self._spec.key

    @property
    def display_name(self) -> str:
        return self._spec.display_name

    @property
    def description(self) -> str | None:
        return self._spec.description

    @property
    def instance_policy(self) -> str:
        return "single"

    @property
    def max_instances(self) -> int | None:
        return 1

    async def discover(self) -> RuntimeTypeDescriptor:
        available = self._spec.available()
        return RuntimeTypeDescriptor(
            runtime_type=self._spec.key,
            display_name=self._spec.display_name,
            description=self._spec.description,
            available=available,
            recommended=False,
            recommendation_rank=5,
            capabilities=dict(CAPABILITIES),
            reason=None if available else f"{self._spec.display_name} CLI not found",
            config_schema=await self.get_config_schema(),
            instance_policy="single",
            max_instances=1,
            metadata={"platform": sys.platform, "kind": "headless-cli"},
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        schema, ui_schema, defaults = shared_config_schema()
        schema, ui_schema, defaults = with_default_model(
            schema, ui_schema, defaults, self._spec.models
        )
        return RuntimeConfigSchema(
            runtime=self._spec.key,
            revision=CONFIG_SCHEMA_REVISION,
            schema=schema,
            ui_schema=ui_schema,
            defaults=defaults,
        )

    async def validate_config(
        self,
        values: dict[str, Any],
    ) -> RuntimeConfig:
        import os

        raw = dict(values or {})
        workspace = raw.get("workspaceDir")
        if isinstance(workspace, str) and workspace.strip():
            raw["workspaceDir"] = os.path.abspath(os.path.expanduser(workspace.strip()))
        else:
            raw.pop("workspaceDir", None)
        model_ids = {model_id for model_id, _title in self._spec.models}
        default_model = raw.get("defaultModel")
        if isinstance(default_model, str) and default_model in model_ids:
            raw["defaultModel"] = default_model
        else:
            raw.pop("defaultModel", None)
        schema_bundle = await self.get_config_schema()
        return RuntimeConfig(
            runtime=self._spec.key,
            revision=CONFIG_SCHEMA_REVISION,
            values=raw,
            schema=schema_bundle.schema,
            ui_schema=schema_bundle.ui_schema,
            metadata={"kind": "headless-cli"},
        )

    async def create_runtime(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
    ) -> HeadlessCliRuntime:
        return HeadlessCliRuntime(config=config, host=host, spec=self._spec)


class MiniMaxProvider(HeadlessCliProvider):
    def __init__(self) -> None:
        super().__init__(
            HeadlessCliSpec(
                key="minimax",
                display_name="MiniMax",
                description="MiniMax Code (mcode exec --prompt-mode work)",
                available=minimax_available,
                build_argv=minimax_argv,
                # Persistent session: measured 4.85s for a follow-up prompt on
                # one `mcode acp` process vs 23-26s for a fresh process per turn.
                acp_command=minimax_acp_command,
            )
        )


class CodeBuddyProvider(HeadlessCliProvider):
    def __init__(self) -> None:
        super().__init__(
            HeadlessCliSpec(
                key="codebuddy",
                display_name="CodeBuddy",
                description="CodeBuddy CLI (codebuddy -p -y; run `codebuddy /login` once first)",
                available=codebuddy_available,
                build_argv=codebuddy_argv,
                models=catalogs.codebuddy_models(),
            )
        )