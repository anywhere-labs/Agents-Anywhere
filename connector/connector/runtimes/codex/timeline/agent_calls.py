from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from connector.runtime_protocol import (
    AgentCallAction,
    AgentCallToolContent,
    RuntimeAgentCall,
)


def codex_agent_call_content(
    native_action: str | None,
    arguments: Any,
    output: Any,
) -> AgentCallToolContent:
    call_arguments = arguments if isinstance(arguments, Mapping) else {}
    targets = _string_tuple(call_arguments.get("receiverThreadIds"))
    agents = output if isinstance(output, Mapping) else {}
    return RuntimeAgentCall(
        action=codex_agent_call_action(native_action),
        title=(
            _optional_string(call_arguments.get("description"))
            or native_action
            or "agent"
        ),
        description=_optional_string(call_arguments.get("description")),
        prompt=_optional_string(call_arguments.get("prompt")),
        agent_id=targets[0] if len(targets) == 1 else None,
        caller_id=_optional_string(call_arguments.get("senderThreadId")),
        target_ids=targets,
        model=_optional_string(call_arguments.get("model")),
        reasoning_effort=_optional_string(call_arguments.get("reasoningEffort")),
        agents=dict(agents),
        input=dict(call_arguments),
        output=dict(agents) if agents else None,
        metadata={"nativeAction": native_action or "agent"},
    ).to_timeline_content()


def codex_agent_call_action(value: str | None) -> AgentCallAction:
    actions: dict[str, AgentCallAction] = {
        "spawnAgent": "spawn",
        "sendInput": "send_input",
        "resumeAgent": "resume",
        "wait": "wait",
        "closeAgent": "close",
    }
    return actions.get(value or "", "unknown")


def collab_agent_arguments_from_raw(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    return {
        "senderThreadId": raw.get("senderThreadId"),
        "receiverThreadIds": raw.get("receiverThreadIds") or [],
        "prompt": raw.get("prompt"),
        "model": raw.get("model"),
        "reasoningEffort": raw.get("reasoningEffort"),
    }


def subagent_activity_native_action(kind: str | None) -> str:
    return {
        "started": "spawnAgent",
        "interacted": "sendInput",
        "interrupted": "closeAgent",
        # Completion is an observed lifecycle event, not a caller action. Preserve
        # the native value so the generic agent-call projection can degrade it to
        # action="unknown" without misrepresenting it as an explicit close.
        "completed": "completed",
    }.get(kind or "", "agent")


def subagent_activity_arguments(
    *,
    agent_path: str,
    agent_thread_id: str,
) -> Mapping[str, Any]:
    return {
        "receiverThreadIds": [agent_thread_id],
        "description": _subagent_display_name(agent_path),
        "agentPath": agent_path,
    }


def subagent_activity_arguments_from_raw(raw: Mapping[str, Any]) -> Mapping[str, Any]:
    agent_path = _optional_string(raw.get("agentPath") or raw.get("agent_path")) or "Agent"
    agent_thread_id = _optional_string(
        raw.get("agentThreadId") or raw.get("agent_thread_id")
    )
    return subagent_activity_arguments(
        agent_path=agent_path,
        agent_thread_id=agent_thread_id or agent_path,
    )


def _subagent_display_name(agent_path: str) -> str:
    name = agent_path.rstrip("/").rsplit("/", 1)[-1]
    return name or "Agent"


def _string_tuple(value: Any) -> tuple[str, ...]:
    if not isinstance(value, list | tuple):
        return ()
    return tuple(item for item in value if isinstance(item, str) and item)


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
