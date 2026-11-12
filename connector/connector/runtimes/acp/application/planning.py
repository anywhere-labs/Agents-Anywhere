from __future__ import annotations

import asyncio
from uuid import uuid4

from acp import RequestError

from connector.planning.domain.session import content_hash
from connector.planning.infrastructure.submission import submit
from connector.runtime_protocol.errors import RuntimeInvalidRequestError
from connector.runtime_protocol.planning import (
    NativePlanningResult,
    PlanningObservation,
)

from ..domain.definitions import AcpError
from ..domain.interactions import Interaction

MODE = "session.planning"
DOCUMENT = "session.plan_document"
REVIEW = "session.plan_review"
MODE_COMMANDS = {"enter_plan", "exit_plan", "submit_task"}
REVIEW_COMMANDS = {"approve_and_execute", "request_revision", "dismiss_review"}


class AcpPlanningPort:
    content_streaming = "final_only"
    prepared_creation = True

    def __init__(self, runtime, features):
        self.runtime = runtime
        self.app = runtime.app
        self.ceiling = features

    def context(self, session_id, external_id=None):
        context = self.app.sessions.get(session_id)
        if context is None or context["closing"]:
            return None
        if external_id is not None and external_id != context["agentSessionId"]:
            return None
        return context

    def mode_option(self, context):
        client = context["client"]
        session_id = context["agentSessionId"]
        spec = client.dialect.planning_mode
        if spec is None:
            return None
        options = client.adapt(session_id, client.configuration.get(session_id, []))
        return next(
            (
                (spec, option["currentValue"])
                for option in options
                if option.get("id") == spec.config_id
                and option.get("type") == "select"
                and option.get("currentValue") is not None
                and {spec.plan, spec.normal}.issubset(
                    item["value"]
                    for group in option.get("options", [])
                    for item in group.get("options", [group])
                    if "value" in item
                )
            ),
            None,
        )

    def features(self, session_id, external_id=None):
        if not session_id:
            return self.ceiling
        context = self.context(session_id, external_id)
        return self.ceiling if context and self.mode_option(context) else ()

    async def available(self, session_id, external_id):
        return MODE in self.features(session_id, external_id)

    def actions(self, session_id, external_id):
        return MODE_COMMANDS | (
            REVIEW_COMMANDS
            if REVIEW in self.features(session_id, external_id)
            else set()
        )

    def can_prepare(self, context, intent):
        return (
            MODE in self.ceiling
            and isinstance(intent, dict)
            and intent.get("mode") == "plan"
            and bool(self.mode_option(context))
        )

    async def prepare_creation(self, session_id, external_id):
        self.runtime.planning.state(session_id).requested_mode = "plan"
        try:
            await self.runtime.host.prepare_planning_turn(session_id, external_id)
        except ValueError as error:
            raise AcpError("planning_unavailable", str(error)) from error
        if await self.read_mode(session_id, external_id) != "plan":
            raise AcpError("planning_unavailable", "Agent 未确认进入规划模式。")

    async def read_mode(self, session_id, external_id):
        context = self.context(session_id, external_id)
        option = self.mode_option(context) if context else None
        if option is None:
            return "unknown"
        spec, value = option
        return "plan" if value == spec.plan else "normal"

    async def change_mode(self, session_id, external_id, mode):
        context = self.context(session_id, external_id)
        option = self.mode_option(context) if context else None
        if option is None:
            return NativePlanningResult(outcome="rejected", code="planning_unavailable")
        spec, current = option
        value = spec.plan if mode == "plan" else spec.normal
        if mode == "normal" and current != spec.plan:
            return NativePlanningResult(mode="normal")
        if value == current:
            return NativePlanningResult(mode=mode)
        try:
            snapshot = self.app.configurations.snapshot(session_id)
            await self.runtime.update_session_configuration(
                session_id,
                {
                    "operationId": uuid4().hex,
                    "expectedRevision": snapshot.revision,
                    "values": {spec.config_id: value},
                },
                planning=True,
            )
        except (AcpError, RequestError, RuntimeInvalidRequestError) as error:
            return NativePlanningResult(
                outcome="rejected",
                code=getattr(error, "code", None)
                if isinstance(error, AcpError)
                else "planning_unavailable",
            )
        if self.context(session_id, external_id) is not context:
            return NativePlanningResult(
                outcome="unknown", code="command_outcome_unknown"
            )
        observed = await self.read_mode(session_id, external_id)
        if observed != mode:
            return NativePlanningResult(
                outcome="rejected", code="planning_unavailable", mode=observed
            )
        return NativePlanningResult(mode=observed)

    async def submit(self, session_id, external_id, request):
        if await self.read_mode(session_id, external_id) != "plan":
            return NativePlanningResult(outcome="rejected", code="planning_unavailable")
        result = await submit(self.runtime, session_id, external_id, request)
        if (
            result.data.get("messageAccepted") is None
            and result.code == "operation_outcome_unknown"
        ):
            return NativePlanningResult(
                outcome="unknown",
                code=result.code,
                execution="unknown",
                data=result.data,
            )
        return result

    def interaction(self, context, agent_id, kind, request):
        if not context.get("sessionId") or not {DOCUMENT, REVIEW}.issubset(
            self.ceiling
        ):
            return None
        proposal = context["client"].dialect.plan_review(kind, request)
        if proposal is None:
            return None

        async def open_review(item):
            session_id = context["sessionId"]
            if self.context(session_id, agent_id) is not context:
                raise AcpError("owner_changed", "计划审阅的会话已变化。")
            if await self.read_mode(session_id, agent_id) != "plan":
                raise AcpError("planning_unavailable", "当前会话不在规划模式。")
            await self.runtime.host.observe_planning(
                PlanningObservation(
                    session_id,
                    "mode",
                    mode="plan",
                    external_session_id=agent_id,
                )
            )
            turn = context["client"].turns.get(agent_id)
            progress_turn, progress = context.get("planningProgress", (None, None))
            await self.runtime.host.observe_planning(
                PlanningObservation(
                    session_id,
                    "proposal",
                    native_id=proposal.native_id,
                    text=proposal.markdown,
                    external_session_id=agent_id,
                    native_review={
                        "noticeId": item.interaction_id,
                        "generation": item.owner_generation,
                        "revision": item.revision,
                        "responses": proposal.responses,
                    },
                    review_actions=tuple(proposal.responses),
                    progress=progress
                    if turn and turn.message_id == progress_turn
                    else None,
                )
            )

        return open_review

    async def review_closed(self, context, notice_id):
        await self.runtime.host.observe_planning(
            PlanningObservation(
                context["sessionId"],
                "review_closed",
                native_id=notice_id,
                external_session_id=context["agentSessionId"],
            )
        )

    async def observe_update(self, context, agent_id, update):
        session_id = context.get("sessionId")
        if not session_id or self.context(session_id, agent_id) is not context:
            return
        kind = update.get("sessionUpdate")
        if kind == "config_option_update" or context[
            "client"
        ].dialect.plan_mode_changed(update):
            mode = await self.read_mode(session_id, agent_id)
            await self.runtime.host.observe_planning(
                PlanningObservation(
                    session_id,
                    "mode",
                    mode=mode,
                    external_session_id=agent_id,
                )
            )
        elif kind == "plan" and await self.available(session_id, agent_id):
            steps = [
                {
                    "step": entry["content"],
                    "status": entry["status"],
                    "priority": entry.get("priority"),
                }
                for entry in update.get("entries", [])
            ]
            progress = {"steps": steps}
            turn = context["client"].turns.get(agent_id)
            if turn is not None:
                context["planningProgress"] = (turn.message_id, progress)
            await self.runtime.host.observe_planning(
                PlanningObservation(
                    session_id,
                    "progress",
                    progress=progress,
                    external_session_id=agent_id,
                )
            )
        elif (
            kind == "tool_call"
            and await self.read_mode(session_id, agent_id) == "normal"
        ):
            state = self.runtime.planning.state(session_id)
            operation = state.operation or {}
            if (state.execution or {}).get("status") == "accepted" or (
                operation.get("command") == "approve_and_execute"
                and operation.get("status") == "dispatching"
            ):
                await self.runtime.host.observe_planning(
                    PlanningObservation(
                        session_id,
                        "execution",
                        mode="normal",
                        external_session_id=agent_id,
                    )
                )

    async def review_is_current(self, session_id, external_id, proposal, native):
        context = self.context(session_id, external_id)
        if not context or not native or context["generation"] != native["generation"]:
            return False
        row = self.app.store.get("interaction", native["noticeId"])
        if not (
            row
            and row.get("plan_review")
            and row["scope_id"] == context["scopeId"]
            and row["revision"] == native["revision"]
            and self.app.interactions.is_open(Interaction(**row))
            and await self.read_mode(session_id, external_id) == "plan"
        ):
            return False
        try:
            current = context["client"].dialect.plan_review(row["kind"], row["request"])
            return bool(
                current
                and content_hash(current.markdown) == proposal.get("contentHash")
                and current.responses == native["responses"]
            )
        except (AcpError, OSError, ValueError):
            return False

    async def review(
        self, session_id, external_id, proposal, native, action, feedback, operation_id
    ):
        if not await self.review_is_current(session_id, external_id, proposal, native):
            return NativePlanningResult(outcome="rejected", code="plan_review_expired")
        response = native["responses"].get(action)
        if response is None:
            return NativePlanningResult(outcome="rejected", code="planning_unavailable")
        response = dict(response)
        field = response.pop("feedbackField", None)
        if field is not None:
            response["input"] = {
                **response["input"],
                field: response["input"][field] + feedback,
            }
        context = self.context(session_id, external_id)
        try:
            self.app.interactions.respond(
                context["scopeId"],
                {
                    "interactionId": native["noticeId"],
                    "ownerGeneration": native["generation"],
                    "requestRevision": native["revision"],
                    "responseOperationId": operation_id,
                    **response,
                },
                plan_review=True,
            )
        except AcpError as error:
            return NativePlanningResult(outcome="rejected", code=error.code)
        if action == "dismiss_review":
            try:
                async with asyncio.timeout(5):
                    while (
                        session_id in self.app.active_runs
                        and self.context(session_id, external_id) is context
                    ):
                        await asyncio.sleep(0.02)
            except TimeoutError:
                return NativePlanningResult(
                    outcome="unknown", code="command_outcome_unknown"
                )
        return NativePlanningResult(
            execution="accepted" if action == "approve_and_execute" else "not_requested"
        )
