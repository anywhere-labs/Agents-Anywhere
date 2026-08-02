from __future__ import annotations

from typing import Any, ClassVar

from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeAttachment,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeHostClient,
    RuntimeInventoryItem,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeSupervisor,
)


class RuntimeRpcHandler:
    """Routes backend runtime RPC methods to Agent Runtime Protocol calls."""

    METHODS: ClassVar[set[str]] = {
        "runtime.discover",
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
        if method == "runtime.validateConfig":
            runtime_id = _required_runtime_id(params)
            config = _runtime_config(params)
            await self.agent_runtime_supervisor.validate_config(runtime_id, config)
            return {"runtimeId": runtime_id, "valid": True}
        if method == "runtime.start":
            runtime_id = _required_runtime_id(params)
            values = _runtime_config(params)
            await self.agent_runtime_supervisor.start(runtime_id, values)
            self.runtime_config_store.save(runtime_id, values)
            return {"runtimeId": runtime_id, "status": "running"}
        if method == "runtime.stop":
            runtime_id = _required_runtime_id(params)
            await self.agent_runtime_supervisor.stop(runtime_id)
            return {"runtimeId": runtime_id, "status": "stopped"}
        if method == "runtime.modelCatalog":
            runtime = self._resolve_agent_runtime(params)
            catalog = await runtime.list_model_catalog(
                query=_optional_string(params.get("query")),
                limit=_int_param(params, "limit", 100),
            )
            return {"catalog": _model_catalog_payload(catalog)}
        if method == "runtime.permissionCatalog":
            runtime = self._resolve_agent_runtime(params)
            catalog = await runtime.list_permission_catalog(
                query=_optional_string(params.get("query")),
                limit=_int_param(params, "limit", 100),
            )
            return {"catalog": _permission_catalog_payload(catalog)}
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
        return {"runtimes": [_agent_inventory_payload(item) for item in agent_items]}

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
            limit=_int_param(params, "limit", 100),
            cursor=_optional_string(params.get("cursor")),
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
            "sessions": [_session_meta_payload(session) for session in sessions],
            "nextCursor": None,
        }

    async def _dispatch_session_create(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.create_and_start_session(
            _required_session_id(params),
            _required_content(params),
            _optional_string(params.get("title")),
            _optional_string(params.get("cwd")),
            _runtime_selections(params),
            _runtime_attachments(params),
            _optional_string(params.get("clientMessageId")),
        )
        return _operation_result_payload(result)

    async def _dispatch_session_sync(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        session_id = _required_session_id(params)
        external_session_id = _optional_string(params.get("externalSessionId"))
        snapshot = await runtime.get_session_snapshot(
            session_id,
            external_session_id,
            _int_param(params, "limit", 100),
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
        session_id = _required_session_id(params)
        external_session_id = _optional_string(params.get("externalSessionId"))
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
        return {"state": _session_state_payload(state)}

    async def _dispatch_session_selections_update(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.update_session_selections(
            _required_session_id(params),
            _optional_string(params.get("externalSessionId")),
            _runtime_selections(params),
        )
        return _operation_result_payload(result)

    async def _dispatch_turn_start(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.start_turn(
            _required_session_id(params),
            _optional_string(params.get("externalSessionId")),
            _required_content(params),
            _runtime_attachments(params),
            _optional_string(params.get("clientMessageId")),
        )
        return _operation_result_payload(result)

    async def _dispatch_turn_steer(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.steer_turn(
            _required_session_id(params),
            _optional_string(params.get("externalSessionId")),
            _required_content(params),
            _runtime_attachments(params),
            _optional_string(params.get("clientMessageId")),
        )
        return _operation_result_payload(result)

    async def _dispatch_interrupt(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.interrupt_turn(
            _required_session_id(params),
            _optional_string(params.get("externalSessionId")),
            _optional_string(params.get("reason")),
        )
        return _operation_result_payload(result)

    async def _dispatch_session_commands(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        commands = await runtime.list_commands(
            session_id=_required_session_id(params),
            external_session_id=_optional_string(params.get("externalSessionId")),
            query=_optional_string(params.get("query")),
            limit=_int_param(params, "limit", 50),
        )
        return {"commands": [_runtime_command_payload(command) for command in commands]}

    async def _dispatch_session_command_execute(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.execute_command(
            session_id=_required_session_id(params),
            command=_required_command(params),
            external_session_id=_optional_string(params.get("externalSessionId")),
            raw=_optional_string(params.get("raw")),
            args=_string_tuple(params.get("args") or ()),
        )
        return _command_result_payload(result)

    async def _dispatch_interaction_respond(
        self,
        runtime: AgentRuntime,
        params: dict[str, Any],
    ) -> dict[str, Any]:
        result = await runtime.respond_interaction(
            session_id=_required_session_id(params),
            notice_id=_required_notice_id(params),
            action_id=_required_action_id(params),
            input_data=_optional_mapping(params.get("inputData")),
        )
        return _operation_result_payload(result)


def _required_runtime_id(params: dict[str, Any]) -> str:
    runtime_id = params.get("runtimeId")
    if not isinstance(runtime_id, str) or not runtime_id:
        raise ValueError("runtimeId is required")
    return runtime_id


def _runtime_config(params: dict[str, Any]) -> dict[str, Any]:
    config = params.get("config")
    if not isinstance(config, dict):
        raise TypeError("config must be an object")
    return config


def _required_session_id(params: dict[str, Any]) -> str:
    session_id = params.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        raise ValueError("sessionId is required")
    return session_id


def _required_content(params: dict[str, Any]) -> str:
    content = params.get("content")
    if not isinstance(content, str):
        raise TypeError("content is required")
    return content


def _required_command(params: dict[str, Any]) -> str:
    command = params.get("command")
    if not isinstance(command, str) or not command:
        raise ValueError("command is required")
    return command


def _required_notice_id(params: dict[str, Any]) -> str:
    notice_id = params.get("noticeId")
    if not isinstance(notice_id, str) or not notice_id:
        raise ValueError("noticeId is required")
    return notice_id


def _required_action_id(params: dict[str, Any]) -> str:
    action_id = params.get("actionId")
    if not isinstance(action_id, str) or not action_id:
        raise ValueError("actionId is required")
    return action_id


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None


def _runtime_attachments(params: dict[str, Any]) -> tuple[RuntimeAttachment, ...]:
    raw_attachments = params.get("attachments") or ()
    if not isinstance(raw_attachments, list | tuple):
        raise TypeError("attachments must be a list")
    attachments: list[RuntimeAttachment] = []
    for raw in raw_attachments:
        if not isinstance(raw, dict):
            raise TypeError("attachment must be an object")
        file_id = raw.get("fileId") or raw.get("file_id")
        if not isinstance(file_id, str) or not file_id:
            raise ValueError("attachment fileId is required")
        attachments.append(
            RuntimeAttachment(
                file_id=file_id,
                name=_optional_string(raw.get("name")),
                media_type=_optional_string(raw.get("mediaType") or raw.get("media_type")),
                size=raw.get("size") if isinstance(raw.get("size"), int) else None,
                sha256=_optional_string(raw.get("sha256")),
            )
        )
    return tuple(attachments)


def _runtime_selections(params: dict[str, Any]) -> dict[str, str | None]:
    raw = params.get("selections") or {}
    if not isinstance(raw, dict):
        raise TypeError("selections must be an object")
    selections: dict[str, str | None] = {}
    for scope, selection_id in raw.items():
        if not isinstance(scope, str) or not scope:
            raise ValueError("selection scope must be a non-empty string")
        if selection_id is not None and not isinstance(selection_id, str):
            raise ValueError("selection id must be a string or null")
        selections[scope] = selection_id
    return selections


def _optional_mapping(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise TypeError("inputData must be an object")
    return dict(value)


def _int_param(params: dict[str, Any], key: str, default: int) -> int:
    value = params.get(key, default)
    if isinstance(value, bool):
        raise TypeError(f"{key} must be an integer")
    if isinstance(value, int):
        return value
    raise ValueError(f"{key} must be an integer")


def _string_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list | tuple):
        raise TypeError("args must be a list")
    args: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise TypeError("args must contain only strings")
        args.append(item)
    return tuple(args)


def _operation_result_payload(result: RuntimeOperationResult) -> dict[str, Any]:
    payload = dict(result.result)
    if result.ok and result.code is None and result.message is None:
        return payload
    return {
        "ok": result.ok,
        **({"code": result.code} if result.code is not None else {}),
        **({"message": result.message} if result.message is not None else {}),
        **payload,
    }


def _command_result_payload(result: RuntimeCommandResult) -> dict[str, Any]:
    return {
        "command": result.command,
        "ok": result.ok,
        "code": result.code,
        "message": result.message,
        "result": dict(result.result),
    }


def _runtime_command_payload(command: RuntimeCommand) -> dict[str, Any]:
    return {
        "id": command.id,
        "title": command.title,
        "description": command.description,
        "aliases": list(command.aliases),
        "category": command.category,
        "scope": command.scope,
        "enabled": command.enabled,
        "disabledReason": command.disabled_reason,
        "acceptsArgs": command.accepts_args,
        "argsSchema": dict(command.args_schema) if command.args_schema is not None else None,
        "metadata": dict(command.metadata),
    }


def _session_state_payload(state: Any) -> dict[str, Any]:
    return {
        "sessionId": state.session_id,
        "runtime": state.runtime,
        "externalSessionId": state.external_session_id,
        "status": state.status,
        "selections": dict(state.selections),
        "statusReason": state.status_reason,
        "error": dict(state.error) if state.error is not None else None,
        "metadata": dict(state.metadata),
    }


def _model_catalog_payload(catalog: RuntimeModelCatalog) -> dict[str, Any]:
    return {
        "runtime": catalog.runtime,
        "revision": catalog.revision,
        "models": [
            {
                "id": model.id,
                "displayName": model.title,
                "selectionId": model.selection_id,
                "description": model.description,
                "default": False,
                "reasoningItems": [
                    {
                        "id": reasoning.id,
                        "displayName": reasoning.title,
                        "selectionId": reasoning.selection_id,
                        "description": reasoning.description,
                        "default": False,
                        "metadata": {
                            **dict(reasoning.metadata),
                            "enabled": reasoning.enabled,
                            **(
                                {"disabledReason": reasoning.disabled_reason}
                                if reasoning.disabled_reason is not None
                                else {}
                            ),
                        },
                    }
                    for reasoning in model.reasoning_items
                ],
                "metadata": {
                    **dict(model.metadata),
                    "enabled": model.enabled,
                    **(
                        {"disabledReason": model.disabled_reason}
                        if model.disabled_reason is not None
                        else {}
                    ),
                },
            }
            for model in catalog.models
        ],
    }


def _permission_catalog_payload(catalog: RuntimePermissionCatalog) -> dict[str, Any]:
    return {
        "runtime": catalog.runtime,
        "revision": catalog.revision,
        "permissions": [
            {
                "id": permission.id,
                "displayName": permission.title,
                "selectionId": permission.selection_id,
                "description": permission.description,
                "default": False,
                "metadata": {
                    **dict(permission.metadata),
                    "enabled": permission.enabled,
                    **(
                        {"disabledReason": permission.disabled_reason}
                        if permission.disabled_reason is not None
                        else {}
                    ),
                },
            }
            for permission in catalog.permissions
        ],
    }


def _session_meta_payload(session: Any) -> dict[str, Any]:
    return {
        "sessionId": session.session_id,
        "externalSessionId": session.external_session_id,
        "runtime": session.runtime,
        "title": session.title,
        "cwd": session.cwd,
        "orderingTime": session.ordering_time,
        "metadata": dict(session.metadata),
    }


def _agent_inventory_payload(item: RuntimeInventoryItem) -> dict[str, Any]:
    return {
        "runtimeId": item.runtime,
        "runtimeType": item.runtime_type,
        "displayName": item.display_name,
        "discovery": {
            "available": item.available,
            **({"reason": item.reason} if item.reason is not None else {}),
        },
        "schema": item.config_schema.schema if item.config_schema is not None else None,
        "uiSchema": item.config_schema.ui_schema if item.config_schema is not None else None,
        "defaults": item.config_schema.defaults if item.config_schema is not None else {},
        "status": "available" if item.available else "unavailable",
        "configured": item.configured,
        "metadata": dict(item.metadata),
    }
