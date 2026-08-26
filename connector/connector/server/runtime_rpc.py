from __future__ import annotations

from collections.abc import Callable
from typing import Any, ClassVar

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeHostClient,
    RuntimeInstancesUnsupportedError,
    RuntimeInvalidRequestError,
    RuntimeScope,
    RuntimeSupervisor,
)
from connector.runtime_protocol.instance_binding import runtime_config_for_instance
from connector.server.runtime_rpc_params import (
    RuntimeCatalogParams,
    RuntimeConfigParams,
    RuntimeIdParams,
    SessionReadParams,
    scoped_runtime,
)
from connector.server.runtime_rpc_payloads import (
    agent_inventory_payload,
    capability_set_payload,
    model_catalog_payload,
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

BackgroundScheduler = Callable[[Any], None]


class RuntimeRpcHandler:
    """Route Runtime Control and Agent Runtime Protocol calls."""

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
        self._negotiated_control_version: str | None = None

    @property
    def control_version(self) -> str:
        return self._negotiated_control_version or "1.0"

    @property
    def negotiated_control_version(self) -> str | None:
        return self._negotiated_control_version

    def supports(self, method: str) -> bool:
        return method in self.METHODS

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "runtime.discover":
            return await self.discover_runtimes(params)
        if method == "runtime.configSchema":
            parsed = RuntimeIdParams.parse(
                params,
                control_version=self.control_version,
            )
            self._validate_known_scope(parsed.scope)
            schema = await self.agent_runtime_supervisor.provider(
                parsed.runtime_type
            ).get_config_schema()
            result = {"configSchema": runtime_config_schema_payload(schema)}
            return self._scoped_result(parsed.scope, result)
        if method == "runtime.config":
            parsed = RuntimeIdParams.parse(
                params,
                control_version=self.control_version,
            )
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
            )
            return self._scoped_result(
                RuntimeScope(parsed.runtime_id, parsed.runtime_type),
                {"runtimeId": parsed.runtime_id, "status": "running"},
            )
        if method == "runtime.stop":
            parsed = RuntimeIdParams.parse(
                params,
                control_version=self.control_version,
            )
            if self.control_version == "1.0":
                await self.agent_runtime_supervisor.ensure_legacy_instance(
                    parsed.runtime_type
                )
            self._validate_known_scope(parsed.scope, require_entry=True)
            await self.agent_runtime_supervisor.stop(parsed.runtime_id)
            return self._scoped_result(
                parsed.scope,
                {"runtimeId": parsed.runtime_id, "status": "stopped"},
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
            catalog = await runtime.list_model_catalog(
                query=parsed.query,
                limit=parsed.limit,
            )
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
        request = dict(params or {})
        requested_version = _select_control_version(request)
        selected_version = self._negotiated_control_version
        if requested_version is not None:
            if selected_version is not None and selected_version != requested_version:
                raise RuntimeInvalidRequestError(
                    f"Runtime Control {selected_version} is already selected for "
                    "this connection"
                )
            self._negotiated_control_version = requested_version
        elif selected_version == "2.0":
            raise RuntimeInvalidRequestError(
                "Runtime Control 2.0 is already selected for this connection"
            )

        if self.control_version == "2.0":
            descriptors = await self.agent_runtime_supervisor.discover()
            return {
                "selectedControlVersion": "2.0",
                "runtimeTypes": [
                    runtime_type_descriptor_payload(descriptor)
                    for descriptor in descriptors
                ],
            }
        items = await self.agent_runtime_supervisor.discover_legacy()
        return {"runtimes": [agent_inventory_payload(item) for item in items]}

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
        display_name = None
        if self.control_version == "1.0":
            runtime_id = params.get("runtimeId")
            if (
                isinstance(runtime_id, str)
                and runtime_id
                and not runtime_id.startswith("rti_")
            ):
                display_name = self.agent_runtime_supervisor.provider(
                    runtime_id
                ).display_name
        return RuntimeConfigParams.parse(
            params,
            control_version=self.control_version,
            display_name=display_name,
        )

    def _resolve_agent_runtime(self, params: dict[str, Any]) -> AgentRuntime:
        if self.control_version == "1.0" and any(
            isinstance(params.get(key), str) and params[key].startswith("rti_")
            for key in ("runtime", "runtimeId")
        ):
            raise RuntimeInstancesUnsupportedError(
                "named runtime instances require Runtime Control 2.0"
            )
        scope = scoped_runtime(params)
        if self.control_version == "1.0" and not scope.is_legacy:
            raise RuntimeInstancesUnsupportedError(
                "named runtime instances require Runtime Control 2.0"
            )
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
        if self.control_version != "2.0":
            return result
        return {
            **result,
            "runtime": scope.runtime_type,
            "runtimeId": scope.runtime_id,
        }


def _select_control_version(params: dict[str, Any]) -> str | None:
    if not params:
        return None
    if set(params) != {"supportedControlVersions"}:
        raise ValueError("runtime.discover params contain unsupported fields")
    versions = params.get("supportedControlVersions")
    if not isinstance(versions, list) or not versions:
        raise TypeError("supportedControlVersions must be a non-empty array")
    if any(not isinstance(version, str) or not version for version in versions):
        raise TypeError("supportedControlVersions must contain version strings")
    if len(set(versions)) != len(versions):
        raise ValueError("supportedControlVersions must not contain duplicates")
    if "2.0" in versions:
        return "2.0"
    if "1.0" in versions:
        return "1.0"
    raise RuntimeInvalidRequestError(
        "supportedControlVersions does not include a supported Runtime Control version"
    )
