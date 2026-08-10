from __future__ import annotations

from collections.abc import Callable
from typing import Any, ClassVar

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeHostClient,
    RuntimeSupervisor,
)
from connector.server.runtime_rpc_params import (
    RuntimeCatalogParams,
    RuntimeConfigParams,
    RuntimeIdParams,
    SessionReadParams,
)
from connector.server.runtime_rpc_payloads import (
    agent_inventory_payload,
    capability_set_payload,
    model_catalog_payload,
    permission_catalog_payload,
    runtime_config_payload,
    runtime_config_schema_payload,
)
from connector.server.runtime_session_rpc import (
    discover_sessions,
    read_session_capabilities,
    read_session_notices,
    read_session_state,
    sync_session_snapshot,
)
from connector.server.runtime_turn_rpc import (
    dispatch_interaction_respond,
    dispatch_interrupt,
    dispatch_runtime_commands,
    dispatch_session_command_execute,
    dispatch_session_commands,
    dispatch_session_create,
    dispatch_session_selections_update,
    dispatch_turn_start,
    dispatch_turn_steer,
)

BackgroundScheduler = Callable[[Any], None]


class RuntimeRpcHandler:
    """Routes backend runtime RPC methods to Agent Runtime Protocol calls."""

    METHODS: ClassVar[set[str]] = {
        "runtime.discover",
        "runtime.configSchema",
        "runtime.config",
        "runtime.validateConfig",
        "runtime.start",
        "runtime.stop",
        "runtime.capabilities",
        "runtime.commands",
        "runtime.modelCatalog",
        "runtime.permissionCatalog",
        "session.discover",
        "session.create",
        "session.sync",
        "session.state",
        "session.capabilities",
        "session.notices",
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
        schedule_background: BackgroundScheduler | None = None,
    ) -> None:
        self.agent_runtime_supervisor = agent_runtime_supervisor
        self.agent_runtime_host = agent_runtime_host
        self.schedule_background = schedule_background

    def supports(self, method: str) -> bool:
        return method in self.METHODS

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "runtime.discover":
            return await self.discover_runtimes()
        if method == "runtime.configSchema":
            parsed = RuntimeIdParams.parse(params)
            schema = await self.agent_runtime_supervisor.entry(
                parsed.runtime_id
            ).provider.get_config_schema()
            return {"configSchema": runtime_config_schema_payload(schema)}
        if method == "runtime.config":
            parsed = RuntimeIdParams.parse(params)
            entry = self.agent_runtime_supervisor.entry(parsed.runtime_id)
            if entry.runtime is None:
                return {
                    "runtimeId": parsed.runtime_id,
                    "running": False,
                    "config": None,
                }
            config = await entry.runtime.get_config()
            return {
                "runtimeId": parsed.runtime_id,
                "running": True,
                "config": runtime_config_payload(config),
            }
        if method == "runtime.validateConfig":
            parsed = RuntimeConfigParams.parse(params)
            await self.agent_runtime_supervisor.validate_config(
                parsed.runtime_id,
                parsed.config,
                revision=parsed.config_revision,
            )
            return {"runtimeId": parsed.runtime_id, "valid": True}
        if method == "runtime.start":
            parsed = RuntimeConfigParams.parse(params)
            await self.agent_runtime_supervisor.start(
                parsed.runtime_id,
                parsed.config,
                revision=parsed.config_revision,
            )
            return {"runtimeId": parsed.runtime_id, "status": "running"}
        if method == "runtime.stop":
            parsed = RuntimeIdParams.parse(params)
            await self.agent_runtime_supervisor.stop(parsed.runtime_id)
            return {"runtimeId": parsed.runtime_id, "status": "stopped"}
        if method == "runtime.capabilities":
            runtime = self._resolve_agent_runtime(params)
            capabilities = await runtime.get_runtime_capabilities()
            return {"capabilitySet": capability_set_payload(capabilities)}
        if method == "runtime.commands":
            return await dispatch_runtime_commands(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "runtime.modelCatalog":
            runtime = self._resolve_agent_runtime(params)
            parsed = RuntimeCatalogParams.parse(params)
            catalog = await runtime.list_model_catalog(
                query=parsed.query,
                limit=parsed.limit,
            )
            return {"catalog": model_catalog_payload(catalog)}
        if method == "runtime.permissionCatalog":
            runtime = self._resolve_agent_runtime(params)
            parsed = RuntimeCatalogParams.parse(params)
            catalog = await runtime.list_permission_catalog(
                query=parsed.query,
                limit=parsed.limit,
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
            return self.accept_session_sync(params)
        if method == "session.state":
            return await read_session_state(
                self._resolve_agent_runtime(params),
                self.agent_runtime_host,
                params,
            )
        if method == "session.capabilities":
            return await read_session_capabilities(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "session.notices":
            return await read_session_notices(
                self._resolve_agent_runtime(params),
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

    def accept_session_sync(self, params: dict[str, Any]) -> dict[str, Any]:
        """Accept a session sync request and finish it in the background.

        Side effects:
        - schedules snapshot read, timeline sync, state read, and notice read
        - returns immediately so server RPC timeouts do not cancel large reads
        """

        if self.schedule_background is None:
            raise RuntimeError("background scheduler is required for session.sync")
        parsed = SessionReadParams.parse(params)
        runtime = self._resolve_agent_runtime(params)
        self.schedule_background(
            sync_session_snapshot(runtime, self.agent_runtime_host, dict(params))
        )
        return {
            "accepted": True,
            "background": True,
            "sessionId": parsed.session_id,
            "externalSessionId": parsed.external_session_id,
        }

    def _resolve_agent_runtime(self, params: dict[str, Any]) -> AgentRuntime:
        runtime_id = params.get("runtime") if isinstance(params, dict) else None
        if not isinstance(runtime_id, str) or not runtime_id:
            raise ValueError("runtime is required")
        return self.agent_runtime_supervisor.resolve_runtime(runtime_id)
