from __future__ import annotations

from collections.abc import Callable
from typing import Any, ClassVar

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeHostClient,
    RuntimeInvalidRequestError,
    RuntimeScope,
    RuntimeSupervisor,
)
from connector.runtime_protocol.instance_binding import runtime_config_for_instance
from connector.runtime_protocol.model_probe import MODEL_PROBE_FEATURE
from connector.runtime_protocol.switch_fence import (
    CHANNEL_RECONCILE_FENCE_FEATURE,
    SWITCH_FENCE_FEATURE,
)
from connector.runtime_protocol.workflows import RuntimeWorkflowRequest
from connector.server.runtime_rpc_params import (
    RuntimeCatalogParams,
    RuntimeConfigParams,
    RuntimeIdParams,
    SessionReadParams,
    optional_switch_request,
    scoped_runtime,
)
from connector.server.runtime_rpc_payloads import (
    capability_set_payload,
    model_catalog_payload,
    model_connection_result,
    permission_catalog_payload,
    runtime_config_payload,
    runtime_config_schema_payload,
    runtime_type_descriptor_payload,
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
    dispatch_runtime_commands,
    dispatch_session_command_execute,
    dispatch_session_commands,
    dispatch_session_create,
    dispatch_session_interrupt,
    dispatch_session_selections_update,
    dispatch_session_send_message,
    dispatch_session_steer,
)

WORKFLOW_RPC = {
    "workspace.prepare": "prepare", "workspace.preparation.get": "get_preparation",
    "workspace.preparation.refresh": "refresh_preparation", "workspace.preparation.cancel": "cancel_preparation",
    "workspace.preparation.respond": "respond_preparation", "workspace.preparation.reserve": "reserve",
    "session.creation.begin": "begin_creation", "session.creation.get": "get_creation",
    "session.creation.respond": "respond_creation", "session.creation.cancel": "cancel_initialization",
    "interaction.response.get": "get_response", "session.tree": "get_tree", "session.position.select": "select_position",
    "session.close": "close_session", "session.recover": "recover_session",
    "session.agent.operate": "agent_operation",
}

BackgroundScheduler = Callable[[Any], None]

CONNECTOR_FEATURES = (SWITCH_FENCE_FEATURE, MODEL_PROBE_FEATURE, CHANNEL_RECONCILE_FENCE_FEATURE)


class RuntimeRpcHandler:
    """Route Runtime Control and Agent Runtime Protocol calls."""

    METHODS: ClassVar[set[str]] = {
        "session.goal.forget",
        "session.goal.get",
        "session.goal.execute",
        "session.goal.operation",
        "session.planning.operation",
        "session.planning.get",
        "session.planning.execute",
        "runtime.discover",
        "session.configuration.get",
        "session.configuration.update",
        "runtime.configSchema",
        "runtime.config",
        "runtime.validateConfig",
        "runtime.start",
        "runtime.stop",
        "runtime.probeModelConnection",
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
        "session.send_message",
        "session.steer",
        "session.interrupt",
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
        return method in self.METHODS or method in WORKFLOW_RPC

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "session.goal.forget":
            # Only an explicit Server deletion receipt can discard local goal data.
            session_ids = params.get("sessionIds")
            if not isinstance(session_ids, list) or not all(
                isinstance(sid, str) for sid in session_ids
            ):
                raise RuntimeInvalidRequestError("invalid_goal_deletion")
            from connector.goals.store import GoalStore

            for runtime_id in self.agent_runtime_supervisor.runtimes:
                if params.get("runtimeId") and params["runtimeId"] != runtime_id:
                    continue
                entry = self.agent_runtime_supervisor.entry(runtime_id)
                service = entry.runtime.goals if entry.runtime else None
                if service is not None:
                    for sid in session_ids:
                        await service.forget(sid)
                else:
                    host = await self.agent_runtime_host.prepare_runtime_host(
                        runtime_id
                    )
                    kv = getattr(host, "runtime_kv", None)
                    path = kv.path.parent / "goal.sqlite3" if kv else None
                    if path and path.is_file():
                        store = GoalStore(path)
                        for sid in session_ids:
                            store.delete(sid, tombstone=True)
            return {"ok": True}
        if method.startswith("session.goal."):
            runtime = self._resolve_agent_runtime(params)
            parsed = SessionReadParams.parse(params)

            def bind_goal_result(value):
                if isinstance(value, dict):
                    if "sessionId" in value:
                        return {**value, "runtimeId": params.get("runtimeId")}
                    return {key: bind_goal_result(item) for key, item in value.items()}
                return value

            goals = runtime.goals
            if goals is None:
                raise RuntimeInvalidRequestError("goal_unavailable")
            if method == "session.goal.get":
                return bind_goal_result(
                    await goals.snapshot(
                        parsed.session_id,
                        parsed.external_session_id,
                        allow_control=bool(params.get("controlAllowed")),
                    )
                )
            if method == "session.goal.operation":
                return bind_goal_result(
                    await goals.operation(parsed.session_id, str(params["operationId"]))
                )
            if not params.get("controlAllowed"):
                raise RuntimeInvalidRequestError("goal_control_not_allowed")
            try:
                return bind_goal_result(
                    await goals.execute(
                        parsed.session_id,
                        parsed.external_session_id,
                        dict(params["request"]),
                    )
                )
            except ValueError as error:
                return {
                    "operationId": params["request"]["operationId"],
                    "ok": False,
                    "outcome": "rejected",
                    "code": str(error),
                }
        if method in {
            "session.planning.get",
            "session.planning.execute",
            "session.planning.operation",
        }:
            runtime = self._resolve_agent_runtime(params)
            parsed = SessionReadParams.parse(params)
            planning = runtime.planning
            if planning is None:
                return {"capabilities": {"supported": False, "actions": []}, "freshness": "unknown"}
            if method == "session.planning.operation":
                return {"operation": await planning.operation(parsed.session_id, str(params.get("operationId", "")))}
            if method == "session.planning.get":
                return await planning.snapshot(parsed.session_id, parsed.external_session_id, allow_control=params.get("controlAllowed") is True)
            return await planning.execute(parsed.session_id, parsed.external_session_id, dict(params.get("request") or {}))
        if method in {"session.configuration.get", "session.configuration.update"}:
            runtime = self._resolve_agent_runtime(params)
            session_id = params.get("sessionId")
            if not isinstance(session_id, str) or not session_id:
                raise RuntimeInvalidRequestError("sessionId is required")
            result = await runtime.get_session_configuration(session_id) if method.endswith(".get") else await runtime.update_session_configuration(session_id, params)
            return self._runtime_result(runtime, result)
        if method in WORKFLOW_RPC:
            runtime = self._resolve_agent_runtime(params)
            values = {key: value for key, value in params.items() if key not in {"runtime", "runtimeId", "runtimeType"}}
            result = await runtime.execute_workflow(RuntimeWorkflowRequest(WORKFLOW_RPC[method], values))
            return self._runtime_result(runtime, dict(result.values))
        if method == "runtime.discover":
            return await self.discover_runtimes(params)
        if method == "runtime.configSchema":
            parsed = RuntimeIdParams.parse(params)
            self._validate_known_scope(parsed.scope)
            schema = await self.agent_runtime_supervisor.provider(
                parsed.runtime_type
            ).get_config_schema()
            result = {"configSchema": runtime_config_schema_payload(schema)}
            return self._scoped_result(parsed.scope, result)
        if method == "runtime.config":
            parsed = RuntimeIdParams.parse(params)
            self._validate_known_scope(parsed.scope)
            entry = self.agent_runtime_supervisor.entry_or_none(parsed.runtime_id)
            if entry is None or entry.runtime is None:
                result = {
                    "runtimeId": parsed.runtime_id,
                    "running": False,
                    "config": None,
                }
            else:
                config = entry.config
                if config is None:
                    config = await entry.runtime.get_config()
                config = runtime_config_for_instance(config, entry.instance)
                result = {
                    "runtimeId": parsed.runtime_id,
                    "running": entry.status == "running",
                    "config": runtime_config_payload(config),
                }
            return self._scoped_result(parsed.scope, result)
        if method == "runtime.validateConfig":
            parsed = self._parse_config_params(params)
            await self.agent_runtime_supervisor.validate_config(
                parsed.instance,
                parsed.config,
                revision=parsed.config_revision,
                switch=parsed.switch,
            )
            return self._scoped_result(
                RuntimeScope(parsed.runtime_id, parsed.runtime_type),
                {"runtimeId": parsed.runtime_id, "valid": True},
            )
        if method == "runtime.start":
            parsed = self._parse_config_params(params)
            await self.agent_runtime_supervisor.start(
                parsed.instance,
                parsed.config,
                revision=parsed.config_revision,
                switch=parsed.switch,
            )
            entry = self.agent_runtime_supervisor.entry(parsed.runtime_id)
            return self._scoped_result(
                RuntimeScope(parsed.runtime_id, parsed.runtime_type),
                {
                    "runtimeId": parsed.runtime_id,
                    "status": entry.status,
                    **({"error": dict(entry.error)} if entry.error is not None else {}),
                    **({"phase": dict(entry.phase)} if entry.phase is not None else {}),
                    **model_connection_result(entry),
                    "configDigest": self.agent_runtime_supervisor.config_digest(
                        parsed.runtime_id
                    ),
                    "instanceId": self.agent_runtime_supervisor.instance_id,
                },
            )
        if method == "runtime.stop":
            switch = optional_switch_request(params)
            parsed = RuntimeIdParams.parse({key: value for key, value in params.items()
                                            if key not in {"operationId", "switchRevision"}})
            self._validate_known_scope(parsed.scope, require_entry=True)
            await self.agent_runtime_supervisor.stop(parsed.runtime_id, switch=switch)
            return self._scoped_result(
                parsed.scope,
                {"runtimeId": parsed.runtime_id, "status": "stopped"},
            )
        if method == "runtime.probeModelConnection":
            parsed = RuntimeIdParams.parse(params)
            self._validate_known_scope(parsed.scope, require_entry=True)
            probe, digest = await self.agent_runtime_supervisor.probe_model_connection(
                parsed.runtime_id,
                parsed.runtime_type,
            )
            return self._scoped_result(
                parsed.scope,
                {
                    "runtimeId": parsed.runtime_id,
                    "probe": probe.payload(),
                    "configDigest": digest,
                    "instanceId": self.agent_runtime_supervisor.instance_id,
                },
            )
        if method == "runtime.capabilities":
            runtime = self._resolve_agent_runtime(params)
            capabilities = await runtime.get_runtime_capabilities()
            return self._runtime_result(
                runtime,
                {"capabilitySet": capability_set_payload(capabilities)},
            )
        if method == "runtime.commands":
            runtime = self._resolve_agent_runtime(params)
            return self._runtime_result(
                runtime,
                await dispatch_runtime_commands(runtime, params),
            )
        if method == "runtime.modelCatalog":
            runtime = self._resolve_agent_runtime(params)
            parsed = RuntimeCatalogParams.parse(params)
            catalog = await runtime.list_scoped_model_catalog(params["sessionId"], query=parsed.query, limit=parsed.limit) if isinstance(params.get("sessionId"), str) else await runtime.list_model_catalog(query=parsed.query, limit=parsed.limit)
            return self._runtime_result(
                runtime,
                {"catalog": model_catalog_payload(catalog)},
            )
        if method == "runtime.permissionCatalog":
            runtime = self._resolve_agent_runtime(params)
            parsed = RuntimeCatalogParams.parse(params)
            catalog = await runtime.list_permission_catalog(
                query=parsed.query,
                limit=parsed.limit,
            )
            return self._runtime_result(
                runtime,
                {"catalog": permission_catalog_payload(catalog)},
            )
        if method == "session.discover":
            runtime = self._resolve_agent_runtime(params)
            return self._runtime_result(
                runtime,
                await discover_sessions(runtime, self.agent_runtime_host, params),
            )
        if method == "session.create":
            runtime = self._resolve_agent_runtime(params)
            return self._runtime_result(
                runtime,
                await dispatch_session_create(runtime, params),
            )
        if method == "session.sync":
            return self.accept_session_sync(params)
        if method == "session.state":
            runtime = self._resolve_agent_runtime(params)
            return self._runtime_result(
                runtime,
                await read_session_state(runtime, self.agent_runtime_host, params),
            )
        if method == "session.capabilities":
            runtime = self._resolve_agent_runtime(params)
            return self._runtime_result(
                runtime,
                await read_session_capabilities(runtime, params),
            )
        if method == "session.notices":
            runtime = self._resolve_agent_runtime(params)
            return self._runtime_result(
                runtime,
                await read_session_notices(runtime, params),
            )
        if method == "session.selections.update":
            runtime = self._resolve_agent_runtime(params)
            return self._runtime_result(
                runtime,
                await dispatch_session_selections_update(runtime, params),
            )
        if method == "session.commands":
            runtime = self._resolve_agent_runtime(params)
            return self._runtime_result(
                runtime,
                await dispatch_session_commands(runtime, params),
            )
        if method == "session.command.execute":
            runtime = self._resolve_agent_runtime(params)
            return self._runtime_result(
                runtime,
                await dispatch_session_command_execute(runtime, params),
            )
        if method == "interaction.respond":
            runtime = self._resolve_agent_runtime(params)
            return self._runtime_result(
                runtime,
                await dispatch_interaction_respond(runtime, params),
            )
        if method == "session.send_message":
            runtime = self._resolve_agent_runtime(params)
            return self._runtime_result(
                runtime,
                await dispatch_session_send_message(runtime, params),
            )
        if method == "session.steer":
            runtime = self._resolve_agent_runtime(params)
            return self._runtime_result(
                runtime,
                await dispatch_session_steer(runtime, params),
            )
        if method == "session.interrupt":
            runtime = self._resolve_agent_runtime(params)
            return self._runtime_result(
                runtime,
                await dispatch_session_interrupt(runtime, params),
            )
        raise ValueError(f"unsupported runtime method: {method}")

    async def discover_runtimes(
        self,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if params:
            raise RuntimeInvalidRequestError("runtime.discover takes no parameters")
        descriptors = await self.agent_runtime_supervisor.discover()
        return {
            "runtimeTypes": [
                runtime_type_descriptor_payload(descriptor)
                for descriptor in descriptors
            ],
            # Connector-wide protocol features the Server may rely on.
            "features": list(CONNECTOR_FEATURES),
        }

    def accept_session_sync(self, params: dict[str, Any]) -> dict[str, Any]:
        """Accept a session sync request and finish it in the background."""

        if self.schedule_background is None:
            raise RuntimeError("background scheduler is required for session.sync")
        parsed = SessionReadParams.parse(params)
        runtime = self._resolve_agent_runtime(params)
        self.schedule_background(
            sync_session_snapshot(runtime, self.agent_runtime_host, dict(params))
        )
        return self._runtime_result(
            runtime,
            {
                "accepted": True,
                "background": True,
                "sessionId": parsed.session_id,
                "externalSessionId": parsed.external_session_id,
            },
        )

    def _parse_config_params(self, params: dict[str, Any]) -> RuntimeConfigParams:
        return RuntimeConfigParams.parse(params)

    def _resolve_agent_runtime(self, params: dict[str, Any]) -> AgentRuntime:
        scope = scoped_runtime(params)
        return self.agent_runtime_supervisor.resolve_runtime(
            scope.runtime_id,
            scope.runtime_type,
        )

    def _validate_known_scope(
        self,
        scope: RuntimeScope,
        *,
        require_entry: bool = False,
    ) -> None:
        self.agent_runtime_supervisor.provider(scope.runtime_type)
        entry = self.agent_runtime_supervisor.entry_or_none(scope.runtime_id)
        if entry is None:
            if require_entry:
                raise RuntimeInvalidRequestError(
                    f"unknown runtime instance {scope.runtime_id!r}"
                )
            return
        if entry.runtime_type != scope.runtime_type:
            raise RuntimeInvalidRequestError(
                f"runtime instance {scope.runtime_id!r} belongs to type "
                f"{entry.runtime_type!r}, not {scope.runtime_type!r}"
            )

    def _runtime_result(
        self,
        runtime: AgentRuntime,
        result: dict[str, Any],
    ) -> dict[str, Any]:
        identity = runtime.identity
        runtime_id = identity.runtime_id or identity.runtime
        return self._scoped_result(
            RuntimeScope(runtime_id=runtime_id, runtime_type=identity.runtime),
            result,
        )

    def _scoped_result(
        self,
        scope: RuntimeScope,
        result: dict[str, Any],
    ) -> dict[str, Any]:
        return {
            **result,
            "runtime": scope.runtime_type,
            "runtimeId": scope.runtime_id,
        }
