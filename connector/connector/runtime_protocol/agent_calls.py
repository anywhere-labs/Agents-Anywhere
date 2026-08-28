from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Any, Literal

from connector.runtime_protocol.timeline import (
    AgentCallToolContent,
    complete_tool_content,
)

AgentCallAction = Literal[
    "invoke",
    "spawn",
    "send_input",
    "resume",
    "wait",
    "close",
    "unknown",
]


@dataclass(frozen=True, slots=True)
class RuntimeAgentCall:
    """Runtime-neutral description of one agent collaboration operation."""

    action: AgentCallAction = "invoke"
    title: str | None = None
    description: str | None = None
    agent_type: str | None = None
    prompt: str | None = None
    run_in_background: bool | None = None
    parent_item_id: str | None = None
    agent_id: str | None = None
    caller_id: str | None = None
    target_ids: tuple[str, ...] = ()
    model: str | None = None
    reasoning_effort: str | None = None
    agents: Mapping[str, Any] | None = None
    usage: Mapping[str, Any] | None = None
    input: Any = None
    output: Any = None
    metadata: Mapping[str, Any] | None = None

    def to_timeline_content(self) -> AgentCallToolContent:
        return AgentCallToolContent(
            title=self.title,
            action=self.action,
            description=self.description,
            agent_type=self.agent_type,
            prompt=self.prompt,
            run_in_background=self.run_in_background,
            parent_item_id=self.parent_item_id,
            agent_id=self.agent_id,
            caller_id=self.caller_id,
            target_ids=self.target_ids,
            model=self.model,
            reasoning_effort=self.reasoning_effort,
            agents=dict(self.agents or {}),
            usage=dict(self.usage or {}),
            input=self.input,
            output=self.output,
            metadata=dict(self.metadata or {}),
        )


def complete_agent_call_content(
    call: AgentCallToolContent,
    *,
    output: Any,
    result: Any,
    is_error: bool,
    agent_id: str | None = None,
    agent_type: str | None = None,
    model: str | None = None,
    target_ids: Sequence[str] | None = None,
    agents: Mapping[str, Any] | None = None,
    usage: Mapping[str, Any] | None = None,
    metadata: Mapping[str, Any] | None = None,
) -> AgentCallToolContent:
    completed = complete_tool_content(
        call,
        output=output,
        result=result,
        is_error=is_error,
        metadata=metadata,
    )
    if not isinstance(completed, AgentCallToolContent):
        raise TypeError("agent call completion changed the content type")
    return replace(
        completed,
        agent_id=agent_id or completed.agent_id,
        agent_type=agent_type or completed.agent_type,
        model=model or completed.model,
        target_ids=(
            tuple(target_ids) if target_ids is not None else completed.target_ids
        ),
        agents=dict(agents) if agents is not None else completed.agents,
        usage={**dict(completed.usage), **dict(usage or {})},
    )
