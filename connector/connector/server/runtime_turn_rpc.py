from __future__ import annotations

from typing import Any

from connector.runtime_protocol import AgentRuntime
from connector.server.runtime_rpc_params import (
    int_param,
    optional_mapping,
    optional_string,
    required_action_id,
    required_command,
    required_content,
    required_notice_id,
    required_session_id,
    runtime_attachments,
    runtime_selections,
    string_tuple,
)
from connector.server.runtime_rpc_payloads import (
    command_result_payload,
    operation_result_payload,
    runtime_command_payload,
)


async def dispatch_session_create(
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


async def dispatch_session_selections_update(
    runtime: AgentRuntime,
    params: dict[str, Any],
) -> dict[str, Any]:
    result = await runtime.update_session_selections(
        required_session_id(params),
        optional_string(params.get("externalSessionId")),
        runtime_selections(params),
    )
    return operation_result_payload(result)


async def dispatch_turn_start(
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


async def dispatch_turn_steer(
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


async def dispatch_interrupt(
    runtime: AgentRuntime,
    params: dict[str, Any],
) -> dict[str, Any]:
    result = await runtime.interrupt_turn(
        required_session_id(params),
        optional_string(params.get("externalSessionId")),
        optional_string(params.get("reason")),
    )
    return operation_result_payload(result)


async def dispatch_session_commands(
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


async def dispatch_session_command_execute(
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


async def dispatch_interaction_respond(
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
