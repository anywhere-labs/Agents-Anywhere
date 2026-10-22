"""Authoritative workspace membership received from a native runtime."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class NativeWorkspace(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    id: str = Field(min_length=1, max_length=256)
    title: str = Field(min_length=1, max_length=255)
    path: str = Field(min_length=1, max_length=4096)
    roots: list[str] | None = Field(default=None, max_length=256)
    sessionIds: list[str] = Field(max_length=50_000)


class RuntimeWorkspaceInventory(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[1]
    complete: Literal[True]
    snapshotId: str = Field(min_length=1, max_length=128)
    observedAt: datetime
    workspaces: list[NativeWorkspace] = Field(max_length=10_000)
    membershipScope: Literal["runtime", "tracked"] = "runtime"

    @model_validator(mode="after")
    def valid_membership(self) -> RuntimeWorkspaceInventory:
        if self.observedAt.tzinfo is None:
            raise ValueError("observedAt must include a timezone")
        workspace_ids: set[str] = set()
        session_ids: set[str] = set()
        for workspace in self.workspaces:
            if workspace.roots is not None and (
                not workspace.roots
                or workspace.path not in workspace.roots
                or any(not root or len(root) > 4096 for root in workspace.roots)
            ):
                raise ValueError("workspace roots must include the primary directory")
            if workspace.id in workspace_ids:
                raise ValueError("duplicate workspace id")
            workspace_ids.add(workspace.id)
            for session_id in workspace.sessionIds:
                if not session_id or len(session_id) > 256 or session_id in session_ids:
                    raise ValueError(
                        "session ids must be nonempty and owned by one workspace"
                    )
                session_ids.add(session_id)
                if len(session_ids) > 50_000:
                    raise ValueError("workspace inventory exceeds the membership limit")
        return self


@dataclass(frozen=True)
class WorkspaceSyncResult:
    session_ids: list[str] = field(default_factory=list)
    dashboard_changed: bool = False
