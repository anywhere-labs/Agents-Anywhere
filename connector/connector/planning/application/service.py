from __future__ import annotations

import asyncio
import hashlib
import json
import time
from uuid import uuid4

from connector.planning.application.ports import PlanningRuntimePort, PlanningStateStore
from connector.planning.domain.session import PlanningConflict, SessionPlanning
from connector.runtime_protocol.planning import (
    NativePlanningResult,
    PlanningObservation,
)

COMMANDS = {
    "enter_plan",
    "exit_plan",
    "submit_task",
    "approve_and_execute",
    "request_revision",
    "dismiss_review",
}


class PlanningService:
    """Session-scoped use cases. No lock is held over a native or user wait."""

    def __init__(
        self,
        runtime: str,
        port: PlanningRuntimePort,
        store: PlanningStateStore,
        publish,
    ):
        self.runtime, self.port, self.store, self.publish = (
            runtime,
            port,
            store,
            publish,
        )
        self.states: dict[str, SessionPlanning] = {}
        self.locks: dict[str, asyncio.Lock] = {}
        self.publish_locks: dict[str, asyncio.Lock] = {}
        self.last_publish: dict[str, float] = {}
        self.flush_tasks: dict[str, asyncio.Task] = {}
        self.epoch = uuid4().hex
        self.closed = False
        self.inflight: set[str] = set()
        self.published: set[str] = set()
        self.capabilities: dict[str, dict] = {}

    def state(self, session_id: str) -> SessionPlanning:
        if session_id not in self.states:
            saved = self.store.load(session_id)
            state = (
                SessionPlanning(**saved)
                if saved
                else SessionPlanning(session_id, self.runtime)
            )
            state.freshness = "unknown"
            if state.operation and state.operation.get("status") == "dispatching":
                state.operation["status"] = "unknown"
            state.epoch = self.epoch
            self.states[session_id] = state
        return self.states[session_id]

    def lock(self, session_id: str) -> asyncio.Lock:
        return self.locks.setdefault(session_id, asyncio.Lock())

    def validate_document(self, session_id: str, text: str) -> bool:
        from connector.planning.domain.session import content_hash

        state = self.state(session_id)
        review = state.review or {}
        if (
            review.get("status") in {"approved", "responding"}
            and state.operation
            and state.operation.get("command") == "approve_and_execute"
        ):
            return bool(
                state.proposal and content_hash(text) == state.proposal["contentHash"]
            )
        return True

    async def prepare_turn(self, session_id: str, external_id: str | None) -> bool:
        state = self.state(session_id)
        if state.requested_mode != "plan" and not (
            state.effective_mode == "plan" and state.freshness != "fresh"
        ):
            return False
        result = await self.port.change_mode(session_id, external_id, "plan")
        if result.outcome != "applied":
            raise PlanningConflict(result.message or "无法在首轮启用原生规划。")
        state.external_session_id = external_id
        state.mode_observed("plan")
        await self.emit(state)
        return True

    async def snapshot(
        self,
        session_id: str,
        external_id: str | None = None,
        *,
        allow_control: bool = False,
    ) -> dict:
        state = self.state(session_id)
        if external_id:
            state.external_session_id = external_id
        calibrate = getattr(self.port, "calibrate", None)
        if calibrate:
            await calibrate(
                session_id, external_id or state.external_session_id, allow_control
            )
        available = await self.port.available(
            session_id, external_id or state.external_session_id
        )
        if available:
            observed_revision = state.revision
            mode = await self.port.read_mode(
                session_id, external_id or state.external_session_id
            )
            async with self.lock(session_id):
                if state.revision != observed_revision:
                    mode = state.effective_mode
                if mode != "unknown":
                    if mode != state.effective_mode or state.freshness != "fresh":
                        state.mode_observed(mode)
                else:
                    state.freshness = "unknown"
        else:
            state.freshness = "stale"
        latest = getattr(self.port, "latest_proposal", None)
        if available and latest:
            from dataclasses import replace

            revision = state.revision
            proposal = await latest(
                session_id, external_id or state.external_session_id, state.proposal
            )
            if proposal is not None:
                await self.observe(replace(proposal, expected_revision=revision))
        result = state.wire()
        result["capabilities"] = {
            "supported": available,
            "actions": sorted(COMMANDS) if available else [],
            "contentStreaming": getattr(self.port, "content_streaming", "final_only"),
            "reason": None if available else "原生 Plan 控制当前不可用。",
        }
        self.capabilities[session_id] = result["capabilities"]
        if state.review and state.review["status"] == "open":
            review_id = state.review["reviewId"]
            current = await self.port.review_is_current(
                session_id,
                external_id or state.external_session_id,
                dict(state.proposal or {}),
                dict(state.native_review) if state.native_review else None,
            )
            async with self.lock(session_id):
                if (
                    not current
                    and state.review
                    and state.review["reviewId"] == review_id
                    and state.review["status"] == "open"
                ):
                    state.review.update(status="withdrawn", actions=[])
                    state.native_review = None
                    state.revision += 1
            if (
                state.proposal
                and self.document_key(state.proposal) not in self.published
            ):
                await self.emit(state, durable=True)
            result = {**state.wire(), "capabilities": result["capabilities"]}
        return result

    @staticmethod
    def document_key(document: dict) -> str:
        return f"{document['planId']}:{document['revision']}:{document['contentHash']}"

    async def emit(self, state: SessionPlanning, *, durable: bool = False) -> None:
        async with self.publish_locks.setdefault(state.session_id, asyncio.Lock()):
            await self._emit(state, durable=durable)

    async def _emit(self, state: SessionPlanning, *, durable: bool = False) -> None:
        await asyncio.to_thread(self.store.save, state.saved())
        payload = state.wire()
        if state.session_id in self.capabilities:
            payload["capabilities"] = self.capabilities[state.session_id]
        if durable:
            # The document outbox survives transport loss; each upload is bounded.
            pending = await asyncio.to_thread(self.store.unpublished, state.session_id)
            had_pending = bool(pending)
            while pending:
                document = pending[0]
                await self.publish({**payload, "proposals": [document]}, True)
                await asyncio.to_thread(
                    self.store.mark_published, state.session_id, document
                )
                self.published.add(self.document_key(document))
                pending = await asyncio.to_thread(
                    self.store.unpublished, state.session_id
                )
            if not had_pending:
                await self.publish(payload, True)
            if state.proposal:
                self.published.add(self.document_key(state.proposal))
        else:
            await self.publish(payload, False)
        self.last_publish[state.session_id] = time.monotonic()

    async def observe(self, event: PlanningObservation) -> None:
        if self.closed:
            return
        state = self.state(event.session_id)
        async with self.lock(event.session_id):
            if (
                event.expected_revision is not None
                and state.revision != event.expected_revision
            ):
                return
            if event.external_session_id:
                state.external_session_id = event.external_session_id
            durable = False
            if event.kind == "mode":
                state.mode_observed(event.mode)
                if (
                    event.mode == "normal"
                    and state.review
                    and state.review["status"] == "open"
                ):
                    state.review.update(status="withdrawn", actions=[])
                    state.native_review = None
            elif event.kind == "draft":
                from connector.planning.domain.session import stable_id

                if (
                    state.proposal
                    and state.proposal["planId"]
                    == stable_id("plan_", event.session_id, event.native_id)
                    and state.review
                    and state.review["status"] in {"open", "responding", "approved"}
                ):
                    return  # Late stream chunks cannot replace an already frozen version.
                state.update_draft(event.native_id, event.text, append=event.append)
                if time.monotonic() - self.last_publish.get(event.session_id, 0) < 0.08:
                    if event.session_id not in self.flush_tasks:
                        self.flush_tasks[event.session_id] = asyncio.create_task(
                            self.flush_draft(event.session_id)
                        )
                    return
            elif event.kind == "proposal":
                durable = state.finalize(
                    event.native_id,
                    event.text,
                    turn_id=event.source_turn_id,
                    native_review=dict(event.native_review)
                    if event.native_review is not None
                    else None,
                )
                state.mode_observed("plan")
            elif event.kind == "review_closed" and state.review:
                if event.native_id and event.native_id != (
                    state.native_review or {}
                ).get("noticeId"):
                    return
                if state.review["status"] not in {"open", "responding", "unknown"}:
                    return
                state.review.update(status="withdrawn", actions=[])
                state.native_review = None
                state.revision += 1
                durable = True
            elif event.kind == "interrupted" and state.draft:
                state.draft["contentState"] = "interrupted"
                state.revision += 1
            elif event.kind == "progress":
                state.execution_progress = dict(event.progress or {})
                state.revision += 1
            elif event.kind == "execution":
                if event.mode != "unknown":
                    state.mode_observed(event.mode)
                if state.execution and state.execution["status"] == "accepted":
                    state.execution["status"] = "started"
                    state.revision += 1
                elif (
                    state.operation
                    and state.operation.get("status") == "dispatching"
                    and state.operation.get("command") == "approve_and_execute"
                ):
                    state.execution = {
                        "operationId": state.operation["operationId"],
                        "status": "started",
                        "planId": state.operation.get("planId"),
                        "contentHash": state.operation.get("contentHash"),
                        "retryable": False,
                    }
                    state.revision += 1
                else:
                    return
            else:
                return
            if durable:
                # Archive each frozen body before a later observation compacts it.
                await asyncio.to_thread(self.store.save, state.saved())
        # Final document publication is awaited before a native review can be answered.
        await self.emit(state, durable=durable)

    async def flush_draft(self, session_id: str) -> None:
        try:
            await asyncio.sleep(0.08)
            await self.emit(self.state(session_id))
        finally:
            self.flush_tasks.pop(session_id, None)

    async def execute(
        self, session_id: str, external_id: str | None, request: dict
    ) -> dict:
        command, key = request.get("command"), request.get("operationId")
        if (
            command not in COMMANDS
            or not isinstance(key, str)
            or not key
            or len(key) > 160
        ):
            return self.result(
                "rejected", key, "invalid_planning_command", "缺少有效的规划操作身份。"
            )
        fingerprint = hashlib.sha256(
            json.dumps(request, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()
        previous = await asyncio.to_thread(self.store.operation, session_id, key)
        if previous:
            if previous[0] != fingerprint:
                return self.result(
                    "rejected",
                    key,
                    "operation_conflict",
                    "同一操作身份不能用于不同请求。",
                )
            return previous[1]
        state = self.state(session_id)
        external_id = external_id or state.external_session_id
        if not await self.port.available(session_id, external_id):
            return self.result(
                "rejected", key, "planning_unavailable", "原生 Plan 控制当前不可用。"
            )
        async with self.lock(session_id):
            previous = await asyncio.to_thread(self.store.operation, session_id, key)
            if previous:
                if previous[0] != fingerprint:
                    return self.result(
                        "rejected",
                        key,
                        "operation_conflict",
                        "同一操作身份不能用于不同请求。",
                    )
                return previous[1]
            if session_id in self.inflight:
                return self.result(
                    "rejected",
                    key,
                    "planning_busy",
                    "另一个规划操作正在处理，请刷新状态。",
                )
            if (
                state.operation
                and state.operation.get("status") == "unknown"
                and command == "submit_task"
            ):
                return self.result(
                    "rejected",
                    key,
                    "previous_operation_unknown",
                    "上一轮规划任务结果尚不确定；请先核对原生会话，或用 /plan off 明确结束当前规划流程。",
                )
            resume_execution = bool(
                command == "approve_and_execute"
                and state.review
                and state.review["status"] == "approved"
                and state.execution
                and state.execution.get("status") == "rejected"
                and state.execution.get("retryable")
            )
            try:
                if command in {
                    "approve_and_execute",
                    "request_revision",
                    "dismiss_review",
                }:
                    state.require_review(request, allow_approved=resume_execution)
                    if self.document_key(state.proposal or {}) not in self.published:
                        raise PlanningConflict("计划尚未完成持久保存，请刷新后重试。")
                    if (
                        command == "request_revision"
                        and not str(request.get("feedback", "")).strip()
                    ):
                        raise ValueError("请填写修改意见。")
                    if not resume_execution:
                        state.review["status"] = "responding"
                    state.revision += 1
                elif command in {"enter_plan", "exit_plan", "submit_task"}:
                    if (
                        command == "submit_task"
                        and not str(request.get("content", "")).strip()
                    ):
                        raise ValueError("请填写需要规划的任务。")
                    state.requested_mode = (
                        "normal" if command == "exit_plan" else "plan"
                    )
                proposal = dict(state.proposal or {})
                native = (
                    dict(state.native_review)
                    if state.native_review is not None
                    else None
                )
                target_review_id = (state.review or {}).get("reviewId")
                state.operation = {
                    "operationId": key,
                    "command": command,
                    "status": "dispatching",
                    "planId": proposal.get("planId"),
                    "planRevision": proposal.get("revision"),
                    "contentHash": proposal.get("contentHash"),
                }
                pending = self.result(
                    "unknown",
                    key,
                    "command_outcome_unknown",
                    "操作已准备派发，正在等待原生确认。",
                )
                await asyncio.to_thread(
                    self.store.save, state.saved(), (key, fingerprint, pending)
                )
                self.inflight.add(session_id)
            except (ValueError, PlanningConflict) as exc:
                return self.result("rejected", key, "planning_conflict", str(exc))
        try:
            if command in {"enter_plan", "exit_plan", "submit_task"}:
                # A native wait must be dismissed before switching modes.
                if command == "exit_plan" and native is not None and state.review:
                    dismissed = await self.port.review(
                        session_id,
                        external_id,
                        proposal,
                        native,
                        "dismiss_review",
                        "",
                        key,
                    )
                    if dismissed.outcome not in {"applied", "pending"}:
                        return await self.finish(state, key, fingerprint, dismissed)
                    state.review.update(status="dismissed", actions=[])
                    state.native_review = None
                changed = await self.port.change_mode(
                    session_id, external_id, state.requested_mode or "plan"
                )
                if changed.mode is not None:
                    state.mode_observed(changed.mode)
                native_result = changed
                if command == "submit_task" and changed.outcome in {
                    "applied",
                    "pending",
                }:
                    native_result = await self.port.submit(
                        session_id, external_id, request
                    )
            elif resume_execution:
                # The original native decision already succeeded. Only a proven
                # rejected submission may be retried, never an unknown effect.
                changed = await self.port.change_mode(session_id, external_id, "normal")
                if changed.outcome != "applied":
                    return await self.finish(state, key, fingerprint, changed)
                native_result = await self.port.submit(
                    session_id,
                    external_id,
                    {
                        "content": "PLEASE IMPLEMENT THIS PLAN:\n\n"
                        + proposal["markdown"],
                        "operationId": key,
                    },
                )
            else:
                native_result = await self.port.review(
                    session_id,
                    external_id,
                    proposal,
                    native,
                    command,
                    str(request.get("feedback", "")),
                    key,
                )
                if native_result.mode is not None:
                    state.mode_observed(native_result.mode)
                if (
                    native_result.outcome in {"applied", "pending"}
                    or native_result.data.get("decisionApplied")
                ) and (state.review or {}).get("reviewId") == target_review_id:
                    state.review.update(
                        status={
                            "approve_and_execute": "approved",
                            "request_revision": "revision_requested",
                            "dismiss_review": "dismissed",
                        }[command],
                        actions=[],
                    )
                    state.native_review = None
                    state.revision += 1
            return await self.finish(state, key, fingerprint, native_result)
        except Exception as exc:  # noqa: BLE001 - post-dispatch SDK failures have unknown effects.
            import logging

            logging.getLogger(__name__).warning(
                "Planning outcome unresolved: %s", type(exc).__name__
            )
            # Once dispatched, a timeout or exception cannot prove the native effect did not happen.
            if state.review and state.review["status"] == "responding":
                state.review.update(status="unknown", actions=[])
            state.freshness = "stale"
            return await self.finish(
                state,
                key,
                fingerprint,
                NativePlanningResult(
                    outcome="unknown",
                    code="command_outcome_unknown",
                    message="结果尚不确定，请先刷新原生状态再决定下一步。",
                    execution="unknown"
                    if command in {"approve_and_execute", "submit_task"}
                    else "not_requested",
                ),
            )
        finally:
            self.inflight.discard(session_id)

    async def finish(
        self,
        state: SessionPlanning,
        key: str,
        fingerprint: str,
        native: NativePlanningResult,
    ) -> dict:
        if (
            native.execution != "not_requested"
            and (state.operation or {}).get("command") == "approve_and_execute"
        ):
            started = bool(
                state.execution
                and state.execution.get("operationId") == key
                and state.execution.get("status") == "started"
            )
            state.execution = {
                "operationId": key,
                "status": "started"
                if started and native.execution == "accepted"
                else native.execution,
                "planId": (state.operation or {}).get("planId"),
                "contentHash": (state.operation or {}).get("contentHash"),
                "retryable": bool(native.data.get("canResumeExecution")),
            }
            state.revision += 1
        state.operation = {
            **(state.operation or {}),
            "operationId": key,
            "status": native.outcome,
            "modeEffect": state.effective_mode,
            "decisionEffect": (state.review or {}).get("status"),
            "executionEffect": native.execution,
        }
        if native.outcome == "rejected":
            state.requested_mode = None
            if state.review and state.review["status"] == "responding":
                state.review["status"] = "open"
        result = self.result(native.outcome, key, native.code, native.message)
        result.update(
            execution=native.execution, state=state.wire(), details=dict(native.data)
        )
        await asyncio.to_thread(
            self.store.save, state.saved(), (key, fingerprint, result)
        )
        try:
            await self.emit(state, durable=True)
        except (RuntimeError, OSError, ValueError, TimeoutError):
            # Publication cannot undo a native effect already recorded in the
            # journal. A subsequent snapshot drains the durable document outbox.
            state.freshness = "stale"
        return result

    @staticmethod
    def result(outcome, key, code=None, message=None) -> dict:
        return {
            "outcome": outcome,
            "operationId": key,
            "code": code,
            "message": message,
            "retryable": False,
            "ok": outcome in {"applied", "pending"},
        }

    async def operation(self, session_id: str, key: str) -> dict | None:
        saved = await asyncio.to_thread(self.store.operation, session_id, key)
        return saved[1] if saved else None

    async def close(self) -> None:
        self.closed = True
        tasks = list(self.flush_tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
