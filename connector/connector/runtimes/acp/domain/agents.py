"""Typed Agent definitions shipped with Connector; never user-supplied commands."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .definitions import AgentProfile, LaunchDefinition
from .dialect import AcpDialect

if TYPE_CHECKING:
    from ..provider import AgentContext

# Instance configuration can be edited from the Server, so it never carries
# launch instructions; only the definition decides arguments and environment.
FORBIDDEN_CONFIG_KEYS = frozenset(
    {"command", "commands", "args", "arguments", "argv", "env", "environment", "launch", "shell"}
)


@dataclass(frozen=True)
class Executable:
    """A local command, looked up on PATH and then in the listed candidates."""

    name: str
    candidates: tuple[str, ...] = ()
    windows_npm_entry: str | None = None


@dataclass(frozen=True)
class PathSetting:
    """An optional directory in the instance configuration, passed as an environment variable."""

    key: str
    title: str
    environment: str


@dataclass(frozen=True)
class ConfigSchema:
    schema: Mapping[str, Any]
    ui_schema: Mapping[str, Any] = field(default_factory=dict)
    defaults: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class AcpAgentDefinition:
    """How AA starts one ACP Agent and which differences it has.

    Fixed facts are fields; behaviour that differs between Agents is a hook.
    Agents that only need a local executable leave ``prepare_launch`` and
    ``runtime`` unset and get the shared launcher and runtime.
    """

    runtime_type: str
    display_name: str
    description: str | None = None
    # Shared local launch: executable lookup, fixed arguments and checks.
    executable: Executable | None = None
    arguments: tuple[str, ...] = ()
    check: tuple[str, ...] | None = None
    version: tuple[str, ...] | None = None
    launch_in_workspace: bool = False
    settings: tuple[PathSetting, ...] = ()
    # Instance configuration; generated from ``executable`` and ``settings`` when unset.
    config_schema: ConfigSchema | None = None
    normalize_config: Callable[[Mapping[str, Any], dict], dict] | None = None
    # Capability ceiling and AA-facing facts.
    runtime_capabilities: tuple[str, ...] = ("runtime.attachment",)
    permission_options: tuple[tuple[str, str], ...] = ()
    required_guarantees: frozenset[str] = frozenset()
    native_inventory: bool = True
    metadata: Mapping[str, Any] = field(default_factory=dict)
    maturity: str | None = None
    # A model connection the instance configuration can carry, and how a
    # running instance applied it (see ``RuntimeProvider.model_connection``).
    model_connection: Any = None
    model_connection_status: Callable[[Any], Any] | None = None
    # Hooks.
    dialect: Callable[[AgentContext], AcpDialect] = lambda _context: AcpDialect()
    prepare_launch: Callable[[AgentContext], Callable[[], Awaitable[LaunchDefinition]]] | None = None
    runtime: Callable[[AgentContext, Callable], Any] | None = None

    @property
    def profile(self) -> AgentProfile:
        return AgentProfile(
            id=self.runtime_type,
            title=self.display_name,
            required_guarantees=self.required_guarantees,
            permission_options=self.permission_options,
            runtime_capabilities=self.runtime_capabilities,
            native_inventory=self.native_inventory,
            launch_in_workspace=self.launch_in_workspace,
        )

    def instance_schema(self) -> ConfigSchema:
        if self.config_schema is not None:
            return self.config_schema
        properties: dict[str, dict] = {}
        if self.executable is not None:
            properties["cliPath"] = {
                "type": "string",
                "title": f"本机 {self.executable.name} 路径（可选）",
                "maxLength": 4096,
                "metadata": {
                    "i18n": {"labelKey": "dashboard.device.runtimeConfigFields.agentCliPath.label"},
                },
            }
        for setting in self.settings:
            properties[setting.key] = {"type": "string", "title": setting.title, "maxLength": 4096}
        return ConfigSchema(
            schema={"type": "object", "additionalProperties": False, "properties": properties},
            ui_schema={"order": list(properties), "fields": {}},
        )


def check_definition(definition: AcpAgentDefinition) -> None:
    """Reject definitions whose instance configuration could carry launch instructions."""
    if definition.prepare_launch is None and definition.executable is None:
        raise ValueError(f"{definition.runtime_type}: needs an executable or prepare_launch")
    properties = definition.instance_schema().schema.get("properties", {})
    forbidden = sorted(key for key in properties if key.casefold() in FORBIDDEN_CONFIG_KEYS)
    if forbidden:
        raise ValueError(f"{definition.runtime_type}: configuration must not contain {forbidden}")
    if definition.instance_schema().schema.get("additionalProperties") is not False:
        raise ValueError(f"{definition.runtime_type}: configuration must reject unknown fields")
