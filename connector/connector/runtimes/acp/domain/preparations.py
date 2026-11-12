from __future__ import annotations

from dataclasses import dataclass, replace

from .definitions import AcpError, Workspace


@dataclass(frozen=True)
class Preparation:
    preparation_id: str
    workspace: Workspace
    input_digest: str
    expires_at: float
    revision: int = 0
    phase: str = "opening"
    create_operation_id: str | None = None

    def reserve(
        self, operation_id: str, expected_revision: int, now: float
    ) -> Preparation:
        if self.create_operation_id == operation_id:
            return self
        if self.create_operation_id:
            raise AcpError("preparation_consumed", "准备已绑定其他创建操作。")
        if (
            self.phase != "ready"
            or now >= self.expires_at
            or expected_revision != self.revision
        ):
            raise AcpError("preparation_stale", "工作区准备已失效，请重新准备。")
        return replace(
            self,
            phase="reserved",
            create_operation_id=operation_id,
            revision=self.revision + 1,
        )
