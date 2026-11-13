from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

GoalAction = Literal["set", "edit", "pause", "resume", "clear"]
GoalStatus = Literal[
    "active",
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
    "complete",
    "failed",
    "cleared",
    "replaced",
]


class Goal(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str
    objective: str
    status: GoalStatus
    createdAt: str
    updatedAt: str
    lastReason: str | None = None
    iterations: int | None = Field(default=None, ge=0)
    tokensUsed: int | None = Field(default=None, ge=0)
    tokenBudget: int | None = Field(default=None, gt=0)
    timeUsedSeconds: int | None = Field(default=None, ge=0)
    sourceTurnId: str | None = None
    endedAt: str | None = None


class GoalCapabilities(BaseModel):
    supported: bool = False
    actions: list[GoalAction] = Field(default_factory=list)
    reason: str | None = None


class GoalState(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sessionId: str
    runtime: str
    runtimeId: str | None = None
    externalSessionId: str | None = None
    revision: int = Field(default=0, ge=0, le=9_007_199_254_740_991)
    bindingGeneration: int = Field(default=0, ge=0, le=9_007_199_254_740_991)
    sourceEpoch: str = ""
    sourceRevision: int = Field(default=0, ge=0, le=9_007_199_254_740_991)
    pendingOperationId: str | None = None
    goal: Goal | None = None
    lastOutcome: Goal | None = None
    freshness: Literal["fresh", "stale", "unknown"] = "unknown"
    capabilities: GoalCapabilities = Field(default_factory=GoalCapabilities)

    @model_validator(mode="after")
    def validate_lifecycle(self):
        terminal = {"complete", "failed", "cleared", "replaced"}
        if self.goal is not None and self.goal.status in terminal:
            raise ValueError("current goal must have an unfinished status")
        if self.lastOutcome is not None and self.lastOutcome.status not in terminal:
            raise ValueError("lastOutcome must have an ended status")
        return self


class GoalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operationId: str = Field(min_length=1, max_length=160)
    expectedRevision: int = Field(ge=0)
    action: GoalAction
    objective: str | None = Field(default=None, max_length=2_097_152)
    attachments: list[dict[str, Any]] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def validate_action(self):
        if self.action in {"set", "edit"}:
            if not (self.objective or "").strip():
                raise ValueError("goal objective is required")
            self.objective = self.objective.strip()
        elif self.objective is not None or self.attachments:
            raise ValueError(
                "this goal action does not accept an objective or attachments"
            )
        for ref in self.attachments:
            if (
                not isinstance(ref.get("fileId"), str)
                or not ref["fileId"]
                or "contentBase64" in ref
            ):
                raise ValueError("attachments must reference uploaded files")
        return self


class GoalResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operationId: str
    outcome: Literal["applied", "pending", "rejected", "unknown"]
    ok: bool
    code: str | None = None
    message: str | None = None
    retryable: Literal[False] = False
    state: GoalState | None = None


class GoalCreationIntent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["goal"] = "goal"
    operationId: str = Field(min_length=1, max_length=160)
