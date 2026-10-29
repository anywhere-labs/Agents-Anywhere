from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class AgentComponentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operation: Literal[
        "list", "get_operation", "install", "activate", "rollback", "remove"
    ]
    operationId: str | None = Field(default=None, min_length=1, max_length=160)
    profileId: str | None = Field(
        default=None,
        min_length=1,
        max_length=160,
        pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._-]*$",
    )
    releaseId: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def require_identity(self):
        if self.operation != "list" and not self.operationId:
            raise ValueError("组件操作需要稳定 operationId")
        if self.operation in {"install", "activate", "remove"} and not self.releaseId:
            raise ValueError("组件操作需要 releaseId")
        return self
