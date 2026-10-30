from __future__ import annotations

from pydantic import BaseModel, ConfigDict

from connector.planning.infrastructure.submission import submit
from connector.runtime_protocol.planning import (
    NativePlanningResult,
    PlanningObservation,
)
from connector.runtimes.codex.domain.selections import model_settings_from_selection
from connector.runtimes.codex.sdk.client import (
    codex_low_level_client,
)


class SettingsAck(BaseModel):
    model_config = ConfigDict(extra="allow")


class CodexPlanningPort:
    content_streaming = "native_delta"

    def __init__(self, runtime):
        self.runtime = runtime
        self.modes: dict[str, dict] = {}

    def followed(self, external_id):
        service = self.runtime.ipc_service
        return service.follower.get(external_id) if service and external_id else None

    def external_writer_held(self, external_id):
        from pathlib import Path

        from connector.runtimes.codex.ipc.service import writer_lock_held

        if not external_id or external_id in getattr(
            self.runtime.client, "_loaded_thread_ids", set()
        ):
            return False
        home = self.runtime.config.values.get("codexHome")
        return bool(
            home
            and writer_lock_held(
                Path(home) / "thread-writer-locks" / f"{external_id}.lock"
            )
        )

    async def calibrate(self, session_id, external_id, allow_control):
        if not external_id:
            return
        thread = self.followed(external_id)
        if self.external_writer_held(external_id):
            if self.runtime.ipc_service and (
                not thread or thread.status != "following"
            ):
                await self.runtime.ipc_service.follower.follow(
                    external_id, discovery_timeout_ms=3000
                )
            return  # A held external writer is never resumed through the SDK.
        if allow_control and external_id not in getattr(
            self.runtime.client, "_planning_modes", {}
        ):
            await self.runtime.client.planning_settings(external_id)

    async def available(self, session_id, external_id):
        thread = self.followed(external_id)
        if thread and thread.status != "no_owner":
            return (
                thread.status == "following"
                and thread.state is not None
                and thread.owner_client_id is not None
            )
        return (
            not self.external_writer_held(external_id)
            and codex_low_level_client(getattr(self.runtime.client, "_client", None))
            is not None
        )

    async def read_mode(self, session_id, external_id):
        thread = self.followed(external_id)
        mode = (
            (thread.state or {}).get("latestCollaborationMode")
            if thread and thread.status != "no_owner"
            else getattr(self.runtime.client, "_planning_modes", {}).get(external_id)
        )
        if isinstance(mode, dict) and mode.get("mode") in {"plan", "default"}:
            return "plan" if mode["mode"] == "plan" else "normal"
        return "unknown"

    async def change_mode(self, session_id, external_id, mode):
        if not external_id:
            return NativePlanningResult(
                outcome="rejected", code="native_session_required"
            )
        # A running turn cannot be changed through thread settings.
        if session_id in self.runtime._active_turn_ids:
            return NativePlanningResult(
                outcome="rejected",
                code="planning_turn_running",
                message="请等待当前轮结束后切换规划模式。",
            )
        route = await self.runtime._ipc_route_for_write(session_id, external_id)
        if route.kind == "blocked":
            return NativePlanningResult(
                outcome="rejected",
                code=route.code or "planning_owner_unreachable",
                message=route.message or "原生会话控制连接暂不可用。",
            )
        thread = route.thread if route.kind == "followed" else None
        if thread is None and self.external_writer_held(external_id):
            return NativePlanningResult(
                outcome="rejected",
                code="planning_owner_unreachable",
                message="原生会话由外部进程持有，请先恢复其控制连接。",
            )
        if thread and thread.status != "no_owner":
            current = (thread.state or {}).get("latestCollaborationMode") or {}
            settings = dict(current.get("settings") or {})
        else:
            state = self.runtime._session_states.get(session_id)
            model = await model_settings_from_selection(
                (state.selections if state else {}).get("model"),
                self.runtime._catalogs.list_model_catalog,
            )
            settings = {
                "model": model.model,
                "reasoning_effort": model.effort,
                "developer_instructions": None,
            }
            if not settings["model"]:
                native = await self.runtime.client.planning_settings(external_id)
                settings["model"] = native.get("model")
                settings["reasoning_effort"] = settings.get(
                    "reasoning_effort"
                ) or native.get("reasoning_effort")
            if not settings["model"]:
                read = await self.runtime.client.read_thread(
                    external_id, include_turns=False
                )
                settings["model"] = read.thread.get("model")
        if not settings.get("model"):
            return NativePlanningResult(
                outcome="rejected",
                code="planning_model_unknown",
                message="请先选择模型，再进入规划模式。",
            )
        collaboration = {
            "mode": "plan" if mode == "plan" else "default",
            "settings": settings,
        }
        if thread and thread.status != "no_owner":
            response = await self.runtime.ipc.request(
                "thread-follower-update-thread-settings",
                {
                    "conversationId": external_id,
                    "threadSettings": {"collaborationMode": collaboration},
                },
                target_client_id=thread.owner_client_id,
                host_id=thread.host_id,
                timeout_ms=30000,
            )
            if (
                not response.ok
                or not isinstance(response.result, dict)
                or response.result.get("applied") is not True
            ):
                return NativePlanningResult(
                    outcome="rejected", code="planning_owner_rejected"
                )
        else:
            from openai_codex import JsonRpcError

            try:
                await self.runtime.client.set_collaboration_mode(
                    external_id, collaboration
                )
            except JsonRpcError as exc:
                return NativePlanningResult(
                    outcome="rejected",
                    code="native_planning_rejected",
                    message="原生 Codex 拒绝了模式设置，请检查当前版本与会话状态。",
                    data={"nativeCode": exc.code},
                )
        self.modes[external_id] = collaboration
        return NativePlanningResult(mode=mode)

    async def submit(self, session_id, external_id, request):
        return await submit(self.runtime, session_id, external_id, request)

    async def latest_proposal(self, session_id, external_id, current):
        if await self.read_mode(session_id, external_id) != "plan":
            return None
        from connector.planning.domain.session import content_hash, stable_id
        from connector.runtimes.codex.ipc.timeline import (
            thread_snapshot_from_conversation_state,
        )

        thread = self.followed(external_id)
        if thread and thread.state:
            turns = thread_snapshot_from_conversation_state(thread.state).get(
                "turns", []
            )
        else:
            from connector.runtime_protocol import RuntimeInvalidRequestError

            try:
                page = await self.runtime.client.list_thread_turns_page(
                    external_id, limit=1
                )
            except RuntimeInvalidRequestError:
                return None  # Empty new native threads may not have a readable turn log yet.
            turns = list(page.turns)
        if not turns or turns[-1].get("status") != "completed":
            return None
        for item in reversed(turns[-1].get("items", [])):
            if item.get("type") == "plan" and item.get("text", "").strip():
                if (
                    current
                    and current["planId"] == stable_id("plan_", session_id, item["id"])
                    and current["contentHash"] == content_hash(item["text"])
                ):
                    return None
                return PlanningObservation(
                    session_id=session_id,
                    external_session_id=external_id,
                    kind="proposal",
                    native_id=item["id"],
                    text=item["text"],
                    source_turn_id=turns[-1].get("id"),
                )
        return None

    async def review_is_current(self, session_id, external_id, proposal, native):
        from connector.planning.domain.session import content_hash
        from connector.runtimes.codex.ipc.timeline import (
            thread_snapshot_from_conversation_state,
        )

        thread = self.followed(external_id)
        if thread and thread.status != "no_owner":
            if not thread.state or thread.status != "following":
                return False
            raw = thread_snapshot_from_conversation_state(thread.state)
        else:
            raw = (
                await self.runtime.client.read_thread(external_id, include_turns=True)
            ).thread
        turns = raw.get("turns", [])
        # A later native turn supersedes the review, even if an earlier plan matches.
        for turn in reversed(turns):
            items = turn.get("items", [])
            plans = [
                item
                for item in items
                if item.get("type") == "plan" and item.get("text", "").strip()
            ]
            if plans:
                return content_hash(plans[-1]["text"]) == proposal.get("contentHash")
            if any(item.get("type") == "userMessage" for item in items):
                return False
        return False

    async def review(
        self, session_id, external_id, proposal, native, action, feedback, operation_id
    ):
        if not await self.review_is_current(session_id, external_id, proposal, native):
            return NativePlanningResult(
                outcome="rejected",
                code="plan_review_expired",
                message="原生计划已变化，请刷新后重新审阅。",
            )
        if action == "dismiss_review":
            return NativePlanningResult()
        changed = await self.change_mode(
            session_id,
            external_id,
            "normal" if action == "approve_and_execute" else "plan",
        )
        if changed.outcome != "applied":
            return changed
        content = (
            ("PLEASE IMPLEMENT THIS PLAN:\n\n" + proposal["markdown"])
            if action == "approve_and_execute"
            else feedback
        )
        try:
            result = await self.submit(
                session_id,
                external_id,
                {"content": content, "operationId": operation_id},
            )
        except (RuntimeError, OSError, ValueError, TimeoutError) as exc:
            return NativePlanningResult(
                outcome="unknown",
                code="command_outcome_unknown",
                message="计划决定已应用，后续任务派发结果尚不确定，请核对原生状态。",
                mode=changed.mode,
                execution="unknown",
                data={"decisionApplied": True, "errorType": type(exc).__name__},
            )
        return NativePlanningResult(
            outcome=result.outcome,
            code=result.code,
            message=result.message,
            mode=changed.mode,
            execution="rejected" if result.outcome == "rejected" else result.execution,
            data={
                **result.data,
                "decisionApplied": True,
                "canResumeExecution": action == "approve_and_execute"
                and result.outcome == "rejected",
            },
        )


async def observe_codex_plan(host, session_id, thread_id, event):
    params = (
        event.payload.model_dump(by_alias=True, mode="json")
        if event.payload
        else event.params
    )
    method = event.event_type
    common = {
        "session_id": session_id,
        "external_session_id": thread_id,
        "source_turn_id": event.turn_id,
    }
    if method == "item/plan/delta":
        await host.observe_planning(
            PlanningObservation(
                **common,
                kind="draft",
                native_id=params["itemId"],
                text=params["delta"],
                append=True,
            )
        )
    elif method in {"item/started", "item/completed"}:
        item = params.get("item") or {}
        if item.get("type") == "plan":
            await host.observe_planning(
                PlanningObservation(
                    **common,
                    kind="proposal" if method == "item/completed" else "draft",
                    native_id=item["id"],
                    text=item.get("text", ""),
                )
            )
    elif method == "turn/plan/updated":
        await host.observe_planning(
            PlanningObservation(
                **common,
                kind="progress",
                progress={
                    "steps": params.get("plan", []),
                    "explanation": params.get("explanation"),
                },
            )
        )
    elif event.is_terminal_turn or event.is_failed_turn:
        await host.observe_planning(PlanningObservation(**common, kind="interrupted"))
    elif event.is_turn_started:
        await host.observe_planning(PlanningObservation(**common, kind="review_closed"))
        await host.observe_planning(PlanningObservation(**common, kind="execution"))
    elif method == "thread/settings/updated":
        mode = (params.get("threadSettings", {}).get("collaborationMode") or {}).get(
            "mode"
        )
        if mode in {"plan", "default"}:
            await host.observe_planning(
                PlanningObservation(
                    **common, kind="mode", mode="plan" if mode == "plan" else "normal"
                )
            )


async def observe_ipc_plan(host, session_id, thread):
    from connector.runtimes.codex.ipc.timeline import turn_entities_in_order

    state = thread.state or {}
    collaboration = state.get("latestCollaborationMode") or {}
    mode = collaboration.get("mode")
    if mode in {"plan", "default"}:
        await host.observe_planning(
            PlanningObservation(
                session_id=session_id,
                external_session_id=thread.thread_id,
                kind="mode",
                mode="plan" if mode == "plan" else "normal",
            )
        )
    # Only the latest native turn can create a current synthetic review.
    turns = turn_entities_in_order(state)
    if not turns or mode != "plan":
        return
    key, turn = turns[-1]
    if not any(
        isinstance(item, dict) and item.get("type") == "plan"
        for item in turn.get("items", [])
    ):
        await host.observe_planning(
            PlanningObservation(session_id=session_id, kind="review_closed")
        )
    completed = set(turn.get("completedItemIds") or [])
    for item in turn.get("items") or []:
        if not isinstance(item, dict) or item.get("type") != "plan":
            continue
        text = item.get("text", "")
        final = item.get("id") in completed or turn.get("status") == "completed"
        if final and not text.strip():
            continue
        await host.observe_planning(
            PlanningObservation(
                session_id=session_id,
                external_session_id=thread.thread_id,
                kind="proposal" if final else "draft",
                native_id=item["id"],
                text=text,
                source_turn_id=turn.get("turnId", key),
            )
        )
