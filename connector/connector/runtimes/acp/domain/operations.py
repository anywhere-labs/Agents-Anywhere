from __future__ import annotations

from dataclasses import dataclass, replace

from .definitions import AcpError


@dataclass(frozen=True)
class PromptOperation:
    operation_id: str
    session_id: str
    input_digest: str
    phase: str = "not_sent"
    message_accepted: bool | None = None
    agent_message_id: str | None = None
    evidence: str | None = None

    def dispatch(self) -> PromptOperation:
        if self.phase != "not_sent":
            raise AcpError(
                "operation_outcome_unknown", "消息已提交或结果未知，请查询原操作。"
            )
        return replace(self, phase="dispatching")

    def accept(self, evidence: str, message_id: str | None = None) -> PromptOperation:
        return replace(
            self,
            phase="accepted",
            message_accepted=True,
            evidence=evidence,
            agent_message_id=message_id,
        )

    def lose_connection(self) -> PromptOperation:
        return (
            self
            if self.message_accepted is not None
            else replace(self, phase="outcome_unknown")
        )

    def reject_before_dispatch(self) -> PromptOperation:
        return replace(
            self,
            phase="rejected",
            message_accepted=False,
            evidence="locally_cancelled_before_agent_dispatch",
        )

    def reject(self, evidence: str) -> PromptOperation:
        return replace(
            self, phase="rejected", message_accepted=False, evidence=evidence
        )


@dataclass(frozen=True)
class CreationOperation:
    operation_id: str
    session_id: str
    input_digest: str
    phase: str = "opening"
    platform_session_created: bool | None = True
    agent_session_created: bool | None = None
    message_accepted: bool | None = None
    client_message_id: str | None = None


def require_same_input(original: str, incoming: str) -> None:
    if original != incoming:
        raise AcpError("operation_input_conflict", "相同操作身份不能用于不同输入。")
