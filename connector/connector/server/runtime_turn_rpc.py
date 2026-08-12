from __future__ import annotations

from typing import Any

from connector.runtime_protocol import AgentRuntime
from connector.server.runtime_rpc_params import (
    CommandExecuteParams,
    InteractionRespondParams,
    RuntimeCommandsParams,
    SessionCommandsParams,
    SessionCreateParams,
    SessionInterruptParams,
    SessionSelectionUpdateParams,
    TurnStartParams,
    TurnSteerParams,
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
    parsed = SessionCreateParams.parse(params)
    result = await runtime.create_and_start_session(
        parsed.session_id,
        parsed.content,
        parsed.title,
        parsed.cwd,
        parsed.selections,
        parsed.attachments,
        parsed.client_message_id,
    )
    return operation_result_payload(result)


async def dispatch_session_selections_update(
    runtime: AgentRuntime,
    params: dict[str, Any],
) -> dict[str, Any]:
    parsed = SessionSelectionUpdateParams.parse(params)
    result = await runtime.update_session_selections(
        parsed.session_id,
        parsed.external_session_id,
        parsed.selections,
    )
    return operation_result_payload(result)


async def dispatch_turn_start(
    runtime: AgentRuntime,
    params: dict[str, Any],
) -> dict[str, Any]:
    parsed = TurnStartParams.parse(params)
    result = await runtime.start_turn(
        parsed.session_id,
        parsed.external_session_id,
        parsed.content,
        parsed.selections,
        parsed.attachments,
        parsed.client_message_id,
        cwd=parsed.cwd,
    )
    return operation_result_payload(result)


async def dispatch_turn_steer(
    runtime: AgentRuntime,
    params: dict[str, Any],
) -> dict[str, Any]:
    parsed = TurnSteerParams.parse(params)
    result = await runtime.steer_turn(
        parsed.session_id,
        parsed.external_session_id,
        parsed.content,
        parsed.attachments,
        parsed.client_message_id,
    )
    return operation_result_payload(result)


async def dispatch_session_interrupt(
    runtime: AgentRuntime,
    params: dict[str, Any],
) -> dict[str, Any]:
    parsed = SessionInterruptParams.parse(params)
    result = await runtime.interrupt_session(
        session_id=parsed.session_id,
        reason=parsed.reason,
    )
    return operation_result_payload(result)


async def dispatch_session_commands(
    runtime: AgentRuntime,
    params: dict[str, Any],
) -> dict[str, Any]:
    parsed = SessionCommandsParams.parse(params)
    commands = await runtime.list_commands(
        session_id=parsed.session_id,
        external_session_id=parsed.external_session_id,
        query=parsed.query,
        limit=parsed.limit,
    )
    return {"commands": [runtime_command_payload(command) for command in commands]}


async def dispatch_runtime_commands(
    runtime: AgentRuntime,
    params: dict[str, Any],
) -> dict[str, Any]:
    parsed = RuntimeCommandsParams.parse(params)
    commands = await runtime.list_runtime_commands(limit=parsed.limit)
    return {"commands": [runtime_command_payload(command) for command in commands]}


async def dispatch_session_command_execute(
    runtime: AgentRuntime,
    params: dict[str, Any],
) -> dict[str, Any]:
    parsed = CommandExecuteParams.parse(params)
    result = await runtime.execute_command(
        session_id=parsed.session_id,
        command=parsed.command,
        external_session_id=parsed.external_session_id,
        raw=parsed.raw,
        args=parsed.args,
    )
    return command_result_payload(result)


async def dispatch_interaction_respond(
    runtime: AgentRuntime,
    params: dict[str, Any],
) -> dict[str, Any]:
    parsed = InteractionRespondParams.parse(params)
    result = await runtime.respond_interaction(
        session_id=parsed.session_id,
        notice_id=parsed.notice_id,
        action_id=parsed.action_id,
        input_data=parsed.input_data,
    )
    return operation_result_payload(result)
