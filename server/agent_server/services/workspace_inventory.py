from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Identifier = Annotated[str, Field(min_length=1, max_length=512)]


class NativeWorkspace(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    id: Identifier
    title: str = Field(max_length=16_384)
    path: str = Field(min_length=1, max_length=8192)
    sessionIds: list[Identifier] = Field(max_length=10_000)


class WorkspaceInventory(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    complete: Literal[True]
    workspaces: list[NativeWorkspace] = Field(max_length=10_000)

    @model_validator(mode="after")
    def unique_identities(self):
        if len({workspace.id for workspace in self.workspaces}) != len(self.workspaces):
            raise ValueError("workspace identities must be unique")
        sessions = [
            session for workspace in self.workspaces for session in workspace.sessionIds
        ]
        if len(sessions) > 10_000 or len(set(sessions)) != len(sessions):
            raise ValueError(
                "workspace membership must contain at most 10000 distinct sessions"
            )
        return self
