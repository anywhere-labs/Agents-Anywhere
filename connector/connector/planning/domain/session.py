"""Pure planning rules: mode, document, review and execution are separate facts."""

from __future__ import annotations

import copy
import hashlib
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

MAX_PLAN_BYTES = 2 * 1024 * 1024


class PlanningConflict(ValueError):
    pass


def content_hash(text: str) -> str:
    encoded = text.encode("utf-8", errors="strict")
    if not text.strip() or len(encoded) > MAX_PLAN_BYTES:
        raise ValueError("计划正文为空或超过 2 MiB，不能提交审阅。")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def stable_id(prefix: str, *parts: str) -> str:
    return prefix + hashlib.sha256("\0".join(parts).encode()).hexdigest()[:32]


@dataclass(slots=True)
class SessionPlanning:
    session_id: str
    runtime: str
    effective_mode: str = "unknown"
    requested_mode: str | None = None
    freshness: str = "unknown"
    revision: int = 0
    external_session_id: str | None = None
    draft: dict[str, Any] | None = None
    proposals: list[dict[str, Any]] = field(default_factory=list)
    review: dict[str, Any] | None = None
    native_review: dict[str, Any] | None = None
    epoch: str = ""
    operation: dict[str, Any] | None = None
    execution: dict[str, Any] | None = None
    execution_progress: dict[str, Any] | None = None

    @property
    def proposal(self) -> dict[str, Any] | None:
        return self.proposals[-1] if self.proposals else None

    def mode_observed(self, mode: str) -> None:
        if mode not in {"plan", "normal", "unknown"}:
            raise ValueError("Invalid planning mode")
        if (
            self.effective_mode == mode
            and self.requested_mode is None
            and self.freshness == ("fresh" if mode != "unknown" else "unknown")
        ):
            return
        self.effective_mode = mode
        if mode == self.requested_mode:
            self.requested_mode = None
        self.freshness = "fresh" if mode != "unknown" else "unknown"
        self.revision += 1

    def update_draft(self, native_id: str, text: str, *, append: bool) -> None:
        draft_id = stable_id("draft_", self.session_id, native_id)
        if not self.draft or self.draft["draftId"] != draft_id:
            self.draft = {
                "draftId": draft_id,
                "planId": stable_id("plan_", self.session_id, native_id),
                "revision": 1
                + max(
                    (
                        p["revision"]
                        for p in self.proposals
                        if p["planId"] == stable_id("plan_", self.session_id, native_id)
                    ),
                    default=0,
                ),
                "seq": 0,
                "content": "",
                "contentState": "drafting",
            }
        value = self.draft["content"] + text if append else text
        if len(value.encode("utf-8", errors="strict")) > MAX_PLAN_BYTES:
            self.draft["contentState"] = "failed"
            raise ValueError("计划正文超过 2 MiB。")
        self.draft.update(
            content=value, seq=self.draft["seq"] + 1, contentState="drafting"
        )
        self.revision += 1

    def finalize(
        self,
        native_id: str,
        text: str,
        *,
        turn_id: str | None,
        native_review: dict | None,
    ) -> bool:
        digest = content_hash(text)
        plan_id = stable_id("plan_", self.session_id, native_id)
        current = self.proposal
        if (
            current
            and current["planId"] == plan_id
            and current["contentHash"] == digest
        ):
            return False
        version = 1 + max(
            (p["revision"] for p in self.proposals if p["planId"] == plan_id), default=0
        )
        title = next(
            (
                line.lstrip("#").strip()
                for line in text.splitlines()
                if line.startswith("# ")
            ),
            "计划",
        )
        proposal = {
            "planId": plan_id,
            "revision": version,
            "contentHash": digest,
            "title": title[:200],
            "markdown": text,
            "sourceTurnId": turn_id,
            "contentState": "ready",
            "createdAt": datetime.now(UTC).isoformat(),
        }
        for previous in self.proposals:
            previous.pop("markdown", None)
        self.proposals.append(proposal)
        self.execution = None
        self.execution_progress = None
        self.draft = None
        self.native_review = native_review
        self.review = {
            "reviewId": stable_id("review_", plan_id, str(version)),
            "planId": plan_id,
            "planRevision": version,
            "contentHash": digest,
            "status": "open",
            "actions": ["approve_and_execute", "request_revision", "dismiss_review"],
        }
        self.revision += 1
        return True

    def require_review(
        self, request: dict[str, Any], *, allow_approved: bool = False
    ) -> dict[str, Any]:
        review = self.review
        if (
            not review
            or review["status"]
            not in ({"open", "approved"} if allow_approved else {"open"})
            or self.freshness != "fresh"
        ):
            raise PlanningConflict("计划审阅已处理、已失效或正在重新核对。")
        for key in ("reviewId", "planId", "planRevision", "contentHash"):
            if request.get(key) != review[key]:
                raise PlanningConflict("计划版本已经变化，请重新打开计划确认。")
        expected = request.get("expectedRevision")
        if expected is not None and expected != self.revision:
            raise PlanningConflict("会话状态已变化，请刷新后确认。")
        if request.get("epoch") is not None and request["epoch"] != self.epoch:
            raise PlanningConflict("原生控制实例已变化，请重新核对计划。")
        return review

    def wire(self, *, include_history: bool = False) -> dict[str, Any]:
        value = {
            "sessionId": self.session_id,
            "runtime": self.runtime,
            "effectiveMode": self.effective_mode,
            "requestedMode": self.requested_mode,
            "freshness": self.freshness,
            "revision": self.revision,
            "epoch": self.epoch,
            "draft": self.draft,
            "proposal": self.proposal,
            "review": self.review,
            "operation": self.operation,
            "execution": self.execution,
            "executionProgress": self.execution_progress,
        }
        if include_history:
            value["proposals"] = self.proposals
        return copy.deepcopy(value)

    def saved(self) -> dict[str, Any]:
        return asdict(self)
