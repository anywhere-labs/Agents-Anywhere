"""Current native facts. Completeness is explicit for each independent domain."""

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
    roots: list[str] = Field(min_length=1, max_length=256)
    identityKind: Literal["native", "directory"] = "native"


class WorkspaceMember(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    sessionId: str = Field(min_length=1, max_length=256)
    projectId: str | None
    cwd: str | None = Field(max_length=4096)


class DirectoryObservation(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    path: str = Field(min_length=1, max_length=4096)
    state: Literal["present", "missing", "unknown"]


class RuntimeWorkspaceInventory(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Literal[2]
    epoch: str = Field(min_length=16, max_length=128)
    sequence: int = Field(ge=1, strict=True)
    snapshotId: str = Field(min_length=1, max_length=128)
    observedAt: datetime
    catalogComplete: bool = Field(default=False, strict=True)
    membersComplete: bool = Field(default=False, strict=True)
    workspaces: list[NativeWorkspace] = Field(default_factory=list, max_length=10_000)
    members: list[WorkspaceMember] = Field(default_factory=list, max_length=50_000)
    directories: list[DirectoryObservation] = Field(
        default_factory=list, max_length=60_000
    )

    @model_validator(mode="after")
    def validate_domains(self) -> RuntimeWorkspaceInventory:
        if self.catalogComplete and "workspaces" not in self.model_fields_set:
            raise ValueError(
                "complete catalog requires an explicit workspaces collection"
            )
        if self.membersComplete and "members" not in self.model_fields_set:
            raise ValueError(
                "complete membership requires an explicit members collection"
            )
        if "directories" not in self.model_fields_set:
            raise ValueError("directory observation collection is required")
        if self.observedAt.tzinfo is None:
            raise ValueError("observedAt must include a timezone")
        if not self.catalogComplete and self.workspaces:
            raise ValueError("partial catalogs must not be published")
        if not self.membersComplete and self.members:
            raise ValueError("partial membership must not be published")
        ids = set()
        for workspace in self.workspaces:
            if workspace.id in ids or workspace.path not in workspace.roots:
                raise ValueError("duplicate native identity or invalid project roots")
            if any(not root or len(root) > 4096 for root in workspace.roots):
                raise ValueError("invalid project root")
            ids.add(workspace.id)
        if len({member.sessionId for member in self.members}) != len(self.members):
            raise ValueError("duplicate session identity")
        if (
            self.catalogComplete
            and self.membersComplete
            and any(
                member.projectId is not None and member.projectId not in ids
                for member in self.members
            )
        ):
            raise ValueError("member references an unknown project")
        if len({item.path for item in self.directories}) != len(self.directories):
            raise ValueError("duplicate directory observation")
        return self


class WorkspaceInventoryChunk(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    epoch: str = Field(min_length=16, max_length=128)
    sequence: int = Field(ge=1)
    snapshotId: str = Field(min_length=1, max_length=128)
    digest: str = Field(pattern=r"^[a-f0-9]{64}$")
    index: int = Field(ge=0)
    count: int = Field(ge=1, le=256)
    data: str = Field(max_length=700_000)

    @model_validator(mode="after")
    def validate_index(self) -> WorkspaceInventoryChunk:
        if self.index >= self.count:
            raise ValueError("invalid workspace chunk index")
        return self


@dataclass(frozen=True)
class WorkspaceSyncResult:
    session_ids: list[str] = field(default_factory=list)
    dashboard_changed: bool = False
