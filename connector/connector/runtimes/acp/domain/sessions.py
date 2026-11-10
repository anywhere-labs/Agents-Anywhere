from __future__ import annotations

from dataclasses import dataclass, replace

from .definitions import AcpError, Workspace


@dataclass(frozen=True)
class SessionBinding:
    session_id: str
    profile_id: str
    release_id: str
    workspace: Workspace
    owner_generation: str
    connection_generation: str
    agent_session_id: str | None = None
    attachment: str = "opening"
    foreground: str = "unknown"
    revision: int = 0

    def observe(self, generation: str, **changes) -> SessionBinding:
        if generation != self.connection_generation:
            raise AcpError("owner_changed", "执行者已变化。")
        return replace(self, **changes, revision=self.revision + 1)

    def require_writable(self) -> None:
        if self.attachment != "attached" or self.foreground not in {"idle", "error"}:
            raise AcpError("session_not_ready", "会话尚未空闲或需要恢复。")

    def interrupted(self) -> SessionBinding:
        return replace(
            self,
            attachment="recovery_required",
            foreground="unknown",
            revision=self.revision + 1,
        )
