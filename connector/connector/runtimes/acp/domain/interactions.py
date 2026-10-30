from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Any

from .definitions import AcpError, fingerprint


@dataclass(frozen=True)
class Interaction:
    interaction_id: str
    scope_id: str
    owner_generation: str
    kind: str
    request: dict[str, Any]
    expires_at: float
    revision: int = 1
    status: str = "open"
    response_operation_id: str | None = None
    response_digest: str | None = None
    response: dict[str, Any] | None = None

    def answer(
        self,
        *,
        generation: str,
        revision: int,
        operation_id: str,
        response: dict,
        now: float,
    ) -> Interaction:
        value_digest = fingerprint(response)
        if self.response_operation_id == operation_id:
            if self.response_digest != value_digest:
                raise AcpError("response_input_conflict", "回答身份已用于其他内容。")
            return self
        if generation != self.owner_generation or revision != self.revision:
            raise AcpError("interaction_stale", "交互所属执行者或版本已变化。")
        if self.status != "open" or now >= self.expires_at:
            raise AcpError("interaction_closed", "交互已结束。")
        return replace(
            self,
            status="answered",
            revision=self.revision + 1,
            response_operation_id=operation_id,
            response_digest=value_digest,
            response=response,
        )
