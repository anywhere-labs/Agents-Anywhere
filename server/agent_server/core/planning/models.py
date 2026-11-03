from __future__ import annotations

import hashlib
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

PlanningCommand = Literal[
    "enter_plan",
    "exit_plan",
    "submit_task",
    "approve_and_execute",
    "request_revision",
    "dismiss_review",
]


class PlanningCreationIntent(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["plan"]
    operationId: str = Field(min_length=1, max_length=160)


class PlanningRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    command: PlanningCommand
    operationId: str = Field(min_length=1, max_length=160)
    content: str | None = Field(default=None, max_length=2_097_152)
    feedback: str | None = Field(default=None, max_length=65_536)
    attachments: list[dict[str, Any]] = Field(default_factory=list, max_length=100)
    reviewId: str | None = None
    planId: str | None = None
    planRevision: int | None = Field(default=None, ge=1)
    contentHash: str | None = Field(default=None, pattern=r"^sha256:[0-9a-f]{64}$")
    expectedRevision: int | None = Field(default=None, ge=0)
    epoch: str | None = None

    @model_validator(mode="after")
    def validate_intent(self):
        for attachment in self.attachments:
            if (
                not isinstance(attachment.get("fileId"), str)
                or not attachment["fileId"]
            ):
                raise ValueError("附件必须引用已上传的 fileId。")
            if "contentBase64" in attachment:
                raise ValueError("已存在会话的规划任务不能内联附件。")
        if self.command in {
            "approve_and_execute",
            "request_revision",
            "dismiss_review",
        } and not all(
            (
                self.reviewId,
                self.planId,
                self.planRevision,
                self.contentHash,
                self.epoch,
            )
        ):
            raise ValueError("审阅必须绑定完整计划版本与控制实例。")
        if (
            self.command == "submit_task"
            and not (self.content or "").strip()
            and not self.attachments
        ):
            raise ValueError("规划任务不能为空。")
        if self.command == "request_revision" and not (self.feedback or "").strip():
            raise ValueError("请填写修改意见。")
        if self.attachments and self.command != "submit_task":
            raise ValueError("这个规划命令不接受附件。")
        return self


class PlanDocument(BaseModel):
    model_config = ConfigDict(extra="forbid")
    planId: str = Field(min_length=1, max_length=160)
    revision: int = Field(ge=1)
    contentHash: str = Field(pattern=r"^sha256:[0-9a-f]{64}$")
    title: str = Field(max_length=200)
    markdown: str = Field(min_length=1, max_length=2_097_152)
    sourceTurnId: str | None = None
    createdAt: str | None = None
    contentState: Literal["ready"] = "ready"

    @model_validator(mode="after")
    def verify_hash(self):
        data = self.markdown.encode("utf-8", errors="strict")
        if (
            len(data) > 2_097_152
            or self.contentHash != "sha256:" + hashlib.sha256(data).hexdigest()
        ):
            raise ValueError("计划内容校验失败。")
        return self


class PlanDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    draftId: str
    planId: str
    revision: int = Field(ge=1)
    seq: int = Field(ge=0)
    content: str
    contentState: Literal["drafting", "failed", "interrupted"]


class PlanReview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reviewId: str
    planId: str
    planRevision: int = Field(ge=1)
    contentHash: str
    status: Literal[
        "open",
        "responding",
        "approved",
        "revision_requested",
        "dismissed",
        "withdrawn",
        "unknown",
    ]
    actions: list[PlanningCommand] = Field(default_factory=list)


class PlanningCapabilities(BaseModel):
    supported: bool = False
    actions: list[PlanningCommand] = Field(default_factory=list)
    contentStreaming: Literal["native_delta", "final_only"] = "final_only"
    reason: str | None = None


class PlanningState(BaseModel):
    model_config = ConfigDict(extra="forbid")
    sessionId: str
    runtime: str
    runtimeId: str | None = None
    effectiveMode: Literal["plan", "normal", "unknown"] = "unknown"
    requestedMode: Literal["plan", "normal"] | None = None
    freshness: Literal["fresh", "stale", "unknown"] = "unknown"
    revision: int = Field(default=0, ge=0)
    epoch: str = ""
    draft: PlanDraft | None = None
    proposal: PlanDocument | None = None
    proposals: list[PlanDocument] = Field(default_factory=list)
    review: PlanReview | None = None
    capabilities: PlanningCapabilities = Field(default_factory=PlanningCapabilities)
    operation: dict[str, Any] | None = None
    execution: dict[str, Any] | None = None
    executionProgress: dict[str, Any] | None = None


class PlanningResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    operationId: str
    outcome: Literal["applied", "pending", "rejected", "unknown"]
    ok: bool
    code: str | None = None
    message: str | None = None
    retryable: Literal[False] = False
    execution: Literal[
        "not_requested", "accepted", "started", "rejected", "unknown"
    ] = "not_requested"
    state: PlanningState | None = None
    details: dict[str, Any] = Field(default_factory=dict)
