"""One RuntimeProvider for every ACP Agent definition."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from pathlib import Path

from jsonschema import Draft202012Validator

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeProvider,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.errors import RuntimeInvalidRequestError

from .composition import runtime_root
from .domain.agents import AcpAgentDefinition, check_definition
from .domain.definitions import LaunchDefinition
from .infrastructure.acp.client import AgentClient
from .infrastructure.launch import local_launch
from .runtime import AcpRuntime


@dataclass(frozen=True)
class AgentContext:
    """What hooks receive when AA creates one Runtime instance."""

    definition: AcpAgentDefinition
    config: RuntimeConfig
    host: object
    root: Path


class AcpAgentProvider(RuntimeProvider):
    implementation_type = "acp-stdio"
    instance_policy = "multiple"

    def __init__(self, definition: AcpAgentDefinition):
        check_definition(definition)
        self.definition = definition
        self.profile = definition.profile

    @property
    def runtime_type(self) -> str:
        return self.definition.runtime_type

    @property
    def display_name(self) -> str:
        return self.definition.display_name

    @property
    def description(self) -> str | None:
        return self.definition.description

    @property
    def model_connection(self):
        return self.definition.model_connection

    def model_connection_status(self, config):
        status = self.definition.model_connection_status
        return status(config) if status is not None else None

    async def get_config_schema(self):
        schema = self.definition.instance_schema()
        return RuntimeConfigSchema(
            runtime=self.runtime_type,
            revision=1,
            schema=dict(schema.schema),
            ui_schema=dict(schema.ui_schema),
            defaults=dict(schema.defaults),
        )

    async def discover(self):
        return RuntimeTypeDescriptor(
            runtime_type=self.runtime_type,
            display_name=self.display_name,
            description=self.description,
            available=True,
            implementation_type=self.implementation_type,
            instance_policy=self.instance_policy,
            maturity=self.definition.maturity,
            model_connection=self.definition.model_connection,
            config_schema=await self.get_config_schema(),
            capabilities={
                "workspacePreparation": True,
                "asyncCreation": True,
                "attachments": "runtime.attachment" in self.definition.runtime_capabilities,
            },
            metadata=dict(self.definition.metadata),
        )

    async def validate_config(self, values):
        schema = await self.get_config_schema()
        errors = list(Draft202012Validator(schema.schema).iter_errors(dict(values)))
        if errors:
            # jsonschema quotes the offending value, which may be a credential.
            error = errors[0]
            location = "/".join(str(part) for part in error.absolute_path) or "配置"
            raise RuntimeInvalidRequestError(f"{location} 不符合 {error.validator} 规则")
        normalized = {**schema.defaults, **values}
        if self.definition.normalize_config is not None:
            normalized = self.definition.normalize_config(values, normalized)
        return RuntimeConfig(
            runtime=self.runtime_type,
            revision=1,
            values=normalized,
            schema=schema.schema,
            ui_schema=schema.ui_schema,
        )

    async def create_runtime(self, config, host):
        config = replace(
            config, runtime_id=getattr(host, "runtime_id", None) or config.runtime_id
        )
        context = AgentContext(self.definition, config, host, runtime_root(config, host))

        def client_factory(on_update, on_interaction):
            return AgentClient(on_update, on_interaction, dialect=self.definition.dialect(context))

        build_runtime = self.definition.runtime or validated_runtime
        runtime = build_runtime(context, client_factory)
        if self.definition.planning:
            from connector.planning.infrastructure.binding import bind_planning

            from .application.planning import AcpPlanningPort

            port = AcpPlanningPort(runtime, self.definition.planning)
            bind_planning(runtime, host, port)
            if runtime.planning is not None:
                runtime.app.planning = port
        return runtime


def validated_runtime(context: AgentContext, client_factory) -> AcpRuntime:
    """The shared runtime: the launch is checked again before every preparation and resume."""
    definition, config = context.definition, context.config
    runtime = AcpRuntime(
        config,
        context.host,
        definition.profile,
        LaunchDefinition(
            definition.executable.name if definition.executable else definition.runtime_type,
            definition.arguments,
            definition.runtime_type,
        ),
        client_factory=client_factory,
    )
    prepare = (
        definition.prepare_launch(context)
        if definition.prepare_launch is not None
        else lambda: asyncio.to_thread(local_launch, definition, dict(config.values))
    )

    async def validated_launch():
        launch = await prepare()
        runtime.launch = launch
        runtime.app.launch = launch
        return launch

    async def session_launch(_session_id):
        return await validated_launch()

    runtime.app.launch_for_preparation = validated_launch
    runtime.app.launch_for_session = session_launch
    return runtime
