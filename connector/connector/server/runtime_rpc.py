from __future__ import annotations

from typing import Any, ClassVar

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeHostClient,
    RuntimeSupervisor,
)
from connector.server.runtime_rpc_params import (
    int_param,
    optional_mapping,
    optional_string,
    required_action_id,
    required_command,
    required_content,
    required_notice_id,
    required_runtime_id,
    required_session_id,
    runtime_attachments,
    runtime_config,
    runtime_selections,
    string_tuple,
)
from connector.server.runtime_rpc_payloads import (
    agent_inventory_payload,
    command_result_payload,
    model_catalog_payload,
    operation_result_payload,
    permission_catalog_payload,
    runtime_command_payload,
    runtime_config_payload,
    runtime_config_schema_payload,
    session_meta_payload,
    session_state_payload,
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
        runtime_config_store: Any,
        agent_runtime_host: RuntimeHostClient,
    ) -> None:
        self.agent_runtime_supervisor = agent_runtime_supervisor
        self.runtime_config_store = runtime_config_store
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
            saved_values = self.runtime_config_store.load(runtime_id)
            if entry.runtime is None:
                return {
                    "runtimeId": runtime_id,
                    "running": False,
                    "config": None,
                    "savedValues": saved_values,
                }
            config = await entry.runtime.get_config()
            return {
                "runtimeId": runtime_id,
                "running": True,
                "config": runtime_config_payload(config),
                "savedValues": saved_values,
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
            self.runtime_config_store.save(runtime_id, values)
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
            return await self._dispatch_session_discover(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "session.create":
            return await self._dispatch_session_create(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "session.sync":
            return await self._dispatch_session_sync(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "session.state":
            return await self._dispatch_session_state(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "session.selections.update":
            return await self._dispatch_session_selections_update(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "session.commands":
            return await self._dispatch_session_commands(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "session.command.execute":
            return await self._dispatch_session_command_execute(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "interaction.respond":
            return await self._dispatch_interaction_respond(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "turn.start":
            return await self._dispatch_turn_start(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "turn.steer":
            return await self._dispatch_turn_steer(
                self._resolve_agent_runtime(params),
                params,
            )
        if method == "turn.interrupt":
            return await self._dispatch_interrupt(
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

    async def _dispatch_session_discover(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        sessions = await runtime.list_sessions(
            limit=int_param(params, "limit", 100),
            cursor=optional_string(params.get("cursor")),
            force=bool(params.get("force", True)),
        )
        for session in sessions:
            await self.agent_runtime_host.session_meta_upsert(
                session_id=session.session_id,
                runtime=session.runtime,
                external_session_id=session.external_session_id,
                title=session.title,
                cwd=session.cwd,
                ordering_time=session.ordering_time,
                metadata=session.metadata,
            )
        return {
            "sessions": [session_meta_payload(session) for session in sessions],
            "nextCursor": None,
        }

    async def _dispatch_session_create(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.create_and_start_session(
            required_session_id(params),
            required_content(params),
            optional_string(params.get("title")),
            optional_string(params.get("cwd")),
            runtime_selections(params),
            runtime_attachments(params),
            optional_string(params.get("clientMessageId")),
        )
        return operation_result_payload(result)

    async def _dispatch_session_sync(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        session_id = required_session_id(params)
        external_session_id = optional_string(params.get("externalSessionId"))
        snapshot = await runtime.get_session_snapshot(
            session_id,
            external_session_id,
            int_param(params, "limit", 100),
        )
        await self.agent_runtime_host.timeline_sync(
            session_id=snapshot.session_id,
            runtime=snapshot.runtime,
            external_session_id=snapshot.external_session_id,
            items=snapshot.items,
            complete=snapshot.complete,
            metadata=snapshot.metadata,
        )
        state = await runtime.get_session_state(session_id, external_session_id)
        if state is not None:
            await self.agent_runtime_host.session_state_update(
                session_id=state.session_id,
                runtime=state.runtime,
                external_session_id=state.external_session_id,
                status=state.status,
                selections=state.selections,
                status_reason=state.status_reason,
                error=state.error,
                metadata=state.metadata,
            )
        for notice in await runtime.get_session_notices(session_id, external_session_id):
            await self.agent_runtime_host.notice_upsert(notice)
        return {
            "sessionId": snapshot.session_id,
            "externalSessionId": snapshot.external_session_id,
            "items": len(snapshot.items),
            "complete": snapshot.complete,
        }

    async def _dispatch_session_state(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        session_id = required_session_id(params)
        external_session_id = optional_string(params.get("externalSessionId"))
        state = await runtime.get_session_state(session_id, external_session_id)
        if state is None:
            return {"state": None}
        await self.agent_runtime_host.session_state_update(
            session_id=state.session_id,
            runtime=state.runtime,
            external_session_id=state.external_session_id,
            status=state.status,
            selections=state.selections,
            status_reason=state.status_reason,
            error=state.error,
            metadata=state.metadata,
        )
        return {"state": session_state_payload(state)}

    async def _dispatch_session_selections_update(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.update_session_selections(
            required_session_id(params),
            optional_string(params.get("externalSessionId")),
            runtime_selections(params),
        )
        return operation_result_payload(result)

    async def _dispatch_turn_start(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.start_turn(
            required_session_id(params),
            optional_string(params.get("externalSessionId")),
            required_content(params),
            runtime_attachments(params),
            optional_string(params.get("clientMessageId")),
        )
        return operation_result_payload(result)

    async def _dispatch_turn_steer(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.steer_turn(
            required_session_id(params),
            optional_string(params.get("externalSessionId")),
            required_content(params),
            runtime_attachments(params),
            optional_string(params.get("clientMessageId")),
        )
        return operation_result_payload(result)

    async def _dispatch_interrupt(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.interrupt_turn(
            required_session_id(params),
            optional_string(params.get("externalSessionId")),
            optional_string(params.get("reason")),
        )
        return operation_result_payload(result)

    async def _dispatch_session_commands(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        commands = await runtime.list_commands(
            session_id=required_session_id(params),
            external_session_id=optional_string(params.get("externalSessionId")),
            query=optional_string(params.get("query")),
            limit=int_param(params, "limit", 50),
        )
        return {"commands": [runtime_command_payload(command) for command in commands]}

    async def _dispatch_session_command_execute(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.execute_command(
            session_id=required_session_id(params),
            command=required_command(params),
            external_session_id=optional_string(params.get("externalSessionId")),
            raw=optional_string(params.get("raw")),
            args=string_tuple(params.get("args") or ()),
        )
        return command_result_payload(result)

    async def _dispatch_interaction_respond(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.respond_interaction(
            session_id=required_session_id(params),
            notice_id=required_notice_id(params),
            action_id=required_action_id(params),
            input_data=optional_mapping(params.get("inputData")),
        )
        return operation_result_payload(result)
