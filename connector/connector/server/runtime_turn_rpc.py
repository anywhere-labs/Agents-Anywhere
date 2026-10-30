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
    if params.get("planningIntent") is not None:
        if runtime.planning is None:
            raise ValueError("Native planning is unavailable")
        runtime.planning.state(parsed.session_id).requested_mode = "plan"
    result = await runtime.create_and_start_session(
        parsed.session_id,
        parsed.content,
        parsed.title,
        parsed.cwd,
        parsed.selections,
        parsed.attachments,
        parsed.client_message_id,
        **({"runtime_options": parsed.runtime_options} if parsed.runtime_options else {}),
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


async def dispatch_session_send_message(
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


async def dispatch_session_steer(
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
    if parsed.command == "plan":
        from uuid import uuid4

        from connector.planning.application.commands import parse_plan_command
        if runtime.planning is None:
            return {"command": "plan", "ok": False, "code": "planning_unavailable", "message": "原生 Plan 控制当前不可用。", "result": {}}
        intent = parse_plan_command(parsed.raw if parsed.raw is not None else "/plan" + (" " + " ".join(parsed.args) if parsed.args else ""))
        if intent is None:
            return {"command": "plan", "ok": False, "code": "invalid_command", "message": "请输入完整 /plan 命令。", "result": {}}
        result = await runtime.planning.execute(parsed.session_id, parsed.external_session_id,
            {**intent, "operationId": params.get("operationId") or uuid4().hex})
        return {"command": "plan", "ok": result["ok"], "code": result.get("code"), "message": result.get("message"), "result": result}
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
