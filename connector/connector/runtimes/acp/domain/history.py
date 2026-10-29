from dataclasses import dataclass

from .definitions import AcpError


@dataclass(frozen=True)
class ReplayCheckpoint:
    source_id: str
    epoch: str
    stable_ids: bool
    complete: bool = False

    def require_replacement(self) -> None:
        if self.stable_ids or not self.complete:
            raise AcpError(
                "incomplete_history_replay", "仅完整回放可以替换该来源的旧投影。"
            )
