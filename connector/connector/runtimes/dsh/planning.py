from __future__ import annotations

from connector.planning.infrastructure.submission import submit
from connector.runtime_protocol.planning import (
    NativePlanningResult,
    PlanningObservation,
)


class DshPlanningPort:
    content_streaming = "native_delta"

    def __init__(self, runtime):
        self.runtime = runtime

    def params(self, session_id, external_id):
        return {"sessionId": session_id, "externalSessionId": external_id}

    async def available(self, session_id, external_id):
        try:
            result = await self.runtime._request(
                "getPlanning",
                self.params(session_id, external_id) if external_id else {},
            )
            return result.get("available") is True
        except (RuntimeError, OSError, ValueError, TimeoutError):
            return False

    async def read_mode(self, session_id, external_id):
        result = await self.runtime._request(
            "getPlanning", self.params(session_id, external_id)
        )
        return (
            ("plan" if result["active"] else "normal")
            if type(result.get("active")) is bool
            else "unknown"
        )

    async def change_mode(self, session_id, external_id, mode):
        result = await self.runtime._request(
            "setPlanning",
            {**self.params(session_id, external_id), "active": mode == "plan"},
        )
        active = result.get("active")
        pending = result.get("pending")
        return NativePlanningResult(
            outcome="pending"
            if type(pending) is bool and pending != active
            else "applied",
            mode="plan" if active else "normal",
        )

    async def submit(self, session_id, external_id, request):
        return await submit(self.runtime, session_id, external_id, request)

    async def review_is_current(self, session_id, external_id, proposal, native):
        from connector.planning.domain.session import content_hash

        notices = await self.runtime._request(
            "getSessionNotices", self.params(session_id, external_id)
        )
        return any(
            item.get("noticeId") == (native or {}).get("noticeId")
            and item.get("status") == "open"
            and content_hash(
                (item.get("metadata", {}).get("planningReview") or {}).get(
                    "markdown", ""
                )
            )
            == proposal.get("contentHash")
            for item in notices.get("notices", [])
            if item.get("metadata", {}).get("planningReview")
        )

    async def review(
        self, session_id, external_id, proposal, native, action, feedback, operation_id
    ):
        if (
            not native
            or not native.get("noticeId")
            or not await self.review_is_current(
                session_id, external_id, proposal, native
            )
        ):
            return NativePlanningResult(
                outcome="rejected", code="dsh_plan_review_expired"
            )
        if action == "dismiss_review":
            # Cancel the native turn while it is blocked at the review. Older
            # Plan plugins report cancellation as a tool error and otherwise
            # spend another model step; explicit dismissal must never do that.
            result = await self.runtime.interrupt_session(
                session_id, reason="plan_review_dismissed"
            )
            return NativePlanningResult(
                outcome="applied" if result.ok else "rejected",
                mode="plan",
                code=result.code,
                message=result.message,
            )
        else:
            action_id = "submit"
            data = {
                "answers": {
                    native["questionId"]: {"optionIds": [native["approveOptionId"]]}
                    if action == "approve_and_execute"
                    else {"customText": feedback}
                }
            }
        result = await self.runtime.respond_interaction(
            session_id, native["noticeId"], action_id, data
        )
        return NativePlanningResult(
            outcome="pending"
            if result.ok and action == "approve_and_execute"
            else "applied"
            if result.ok
            else "rejected",
            code=result.code,
            message=result.message,
            execution="accepted"
            if result.ok and action == "approve_and_execute"
            else "not_requested",
        )


async def observe_dsh_notice(host, params):
    review = (params.get("metadata") or {}).get("planningReview")
    if not isinstance(review, dict):
        return False
    if params.get("status") == "open":
        await host.observe_planning(
            PlanningObservation(
                session_id=params["sessionId"],
                kind="proposal",
                native_id=review.get("callId") or params["noticeId"],
                text=review["markdown"],
                native_review={
                    "noticeId": params["noticeId"],
                    **{key: review[key] for key in ("questionId", "approveOptionId")},
                },
            )
        )
    elif params.get("status") in {"closed", "cancelled", "expired"}:
        await host.observe_planning(
            PlanningObservation(
                session_id=params["sessionId"],
                kind="review_closed",
                native_id=params["noticeId"],
            )
        )
    return True
