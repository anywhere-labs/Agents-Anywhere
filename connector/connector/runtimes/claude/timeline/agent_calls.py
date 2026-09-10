from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import (
    AgentCallToolContent,
    RuntimeAgentCall,
    complete_agent_call_content,
)


def claude_agent_call_content(
    *,
    tool_use_id: str,
    tool_input: Mapping[str, Any],
    parent_item_id: str | None,
) -> AgentCallToolContent:
    return RuntimeAgentCall(
        action="invoke",
        title=_string(tool_input.get("description")) or "Agent",
        description=_string(tool_input.get("description")),
        agent_type=_string(
            tool_input.get("subagent_type") or tool_input.get("agent_type")
        ),
        prompt=_string(tool_input.get("prompt")),
        run_in_background=(
            tool_input.get("run_in_background")
            if isinstance(tool_input.get("run_in_background"), bool)
            else None
        ),
        parent_item_id=parent_item_id,
        input=dict(tool_input),
        metadata={"toolUseId": tool_use_id, "toolName": "Agent"},
    ).to_timeline_content()


def complete_claude_agent_call_content(
    call: AgentCallToolContent,
    *,
    output: str,
    result: Any,
    is_error: bool,
    result_details: Mapping[str, Any],
    metadata: Mapping[str, Any],
) -> AgentCallToolContent:
    agent_id = _string(result_details.get("agentId") or result_details.get("agent_id"))
    agent_type = _string(
        result_details.get("agentType") or result_details.get("agent_type")
    )
    model = _string(result_details.get("resolvedModel") or result_details.get("model"))
    status = _string(result_details.get("status"))
    return complete_agent_call_content(
        call,
        output=output,
        result=result,
        is_error=is_error,
        agent_id=agent_id,
        agent_type=agent_type,
        model=model,
        target_ids=(agent_id,) if agent_id is not None else None,
        agents=(
            {agent_id: {"status": status or "completed"}}
            if agent_id is not None
            else None
        ),
        usage=_agent_call_usage(result_details),
        metadata=metadata,
    )


def _agent_call_usage(result: Mapping[str, Any]) -> Mapping[str, int]:
    fields = {
        "durationMs": result.get("totalDurationMs"),
        "tokens": result.get("totalTokens"),
        "toolCalls": result.get("totalToolUseCount"),
    }
    return {
        key: value
        for key, value in fields.items()
        if isinstance(value, int) and not isinstance(value, bool)
    }


def _string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
