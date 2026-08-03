from __future__ import annotations

from typing import Any, ClassVar

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeHostClient,
    RuntimeSupervisor,
)
from connector.server.runtime_rpc_params import (
    int_param,
    optional_string,
    required_runtime_id,
    runtime_config,
)
from connector.server.runtime_rpc_payloads import (
    agent_inventory_payload,
    model_catalog_payload,
    permission_catalog_payload,
    runtime_config_payload,
    runtime_config_schema_payload,
)
from connector.server.runtime_session_rpc import (
    discover_sessions,
    read_session_state,
    sync_session_snapshot,
)
from connector.server.runtime_turn_rpc import (
    dispatch_interaction_respond,
    dispatch_interrupt,
    dispatch_session_command_execute,
    dispatch_session_commands,
    dispatch_session_create,
    dispatch_session_selections_update,
    dispatch_turn_start,
    dispatch_turn_steer,
)


class RuntimeRpcHandler:
    """Routes backend runtime RPC methods to Agent Runtime Protocol calls."""

    METHODS: ClassVar[set[str]] = {
        "runtime.discover",
        "runtime.configSchema",
        "runtime.config",
        "runtime.validateConfig",
        "runtime.start",
        "runtime.stop",
        "runtime.modelCatalog",
        "runtime.permissionCatalog",
        "session.discover",
        "session.create",
        "session.sync",
        "session.state",
        "session.selections.update",
        "session.commands",
        "session.command.execute",
        "interaction.respond",
        "turn.start",
        "turn.steer",
        "turn.interrupt",
    }

    def __init__(
        self,
        agent_runtime_supervisor: RuntimeSupervisor,
        agent_runtime_host: RuntimeHostClient,
    ) -> None:
        self.agent_runtime_supervisor = agent_runtime_supervisor
        self.agent_runtime_host = agent_runtime_host

    def supports(self, method: str) -> bool:
        return method in self.METHODS

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "runtime.discover":
            return await self.discover_runtimes()
        if method == "runtime.configSchema":
            runtime_id = required_runtime_id(params)
            schema = await self.agent_runtime_supervisor.entry(runtime_id).provider.get_config_schema()
            return {"configSchema": runtime_config_schema_payload(schema)}
        if method == "runtime.config":
            runtime_id = required_runtime_id(params)
            entry = self.agent_runtime_supervisor.entry(runtime_id)
            if entry.runtime is None:
                return {
                    "runtimeId": runtime_id,
                    "running": False,
                    "config": None,
                }
            config = await entry.runtime.get_config()
            return {
                "runtimeId": runtime_id,
                "running": True,
                "config": runtime_config_payload(config),
            }
        if method == "runtime.validateConfig":
            runtime_id = required_runtime_id(params)
            config = runtime_config(params)
            await self.agent_runtime_supervisor.validate_config(runtime_id, config)
            return {"runtimeId": runtime_id, "valid": True}
        if method == "runtime.start":
            runtime_id = required_runtime_id(params)
            values = runtime_config(params)
            await self.agent_runtime_supervisor.start(runtime_id, values)
            return {"runtimeId": runtime_id, "status": "running"}
        if method == "runtime.stop":
            runtime_id = required_runtime_id(params)
            await self.agent_runtime_supervisor.stop(runtime_id)
            return {"runtimeId": runtime_id, "status": "stopped"}
        if method == "runtime.modelCatalog":
            runtime = self._resolve_agent_runtime(params)
            catalog = await runtime.list_model_catalog(
                query=optional_string(params.get("query")),
                limit=int_param(params, "limit", 100),
            )
            return {"catalog": model_catalog_payload(catalog)}
        if method == "runtime.permissionCatalog":
            runtime = self._resolve_agent_runtime(params)
            catalog = await runtime.list_permission_catalog(
                query=optional_string(params.get("query")),
                limit=int_param(params, "limit", 100),
            )
            return {"catalog": permission_catalog_payload(catalog)}
        if method == "session.discover":
            return await discover_sessions(
                self._resolve_agent_runtime(params),
                self.agent_runtime_host,
                params,
            )
        if method == "session.create":
            return await dispatch_session_create(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "session.sync":
            return await sync_session_snapshot(
                self._resolve_agent_runtime(params),
                self.agent_runtime_host,
                params,
            )
        if method == "session.state":
            return await read_session_state(
                self._resolve_agent_runtime(params),
                self.agent_runtime_host,
                params,
            )
        if method == "session.selections.update":
            return await dispatch_session_selections_update(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "session.commands":
            return await dispatch_session_commands(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "session.command.execute":
            return await dispatch_session_command_execute(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "interaction.respond":
            return await dispatch_interaction_respond(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "turn.start":
            return await dispatch_turn_start(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "turn.steer":
            return await dispatch_turn_steer(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "turn.interrupt":
            return await dispatch_interrupt(
                self._resolve_agent_runtime(params),
                params,
            )
        raise ValueError(f"unsupported runtime method: {method}")

    async def discover_runtimes(self) -> dict[str, Any]:
        agent_items = await self.agent_runtime_supervisor.discover()
        return {"runtimes": [agent_inventory_payload(item) for item in agent_items]}

    def _resolve_agent_runtime(self, params: dict[str, Any]) -> AgentRuntime:
        runtime_id = params.get("runtime") if isinstance(params, dict) else None
        if not isinstance(runtime_id, str) or not runtime_id:
            raise ValueError("runtime is required")
        return self.agent_runtime_supervisor.resolve_runtime(runtime_id)
