from __future__ import annotations

from dataclasses import dataclass, field

from connector.runtime_protocol import RuntimeSessionStateCache, SessionNotice
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.codex.domain.notices import CodexNoticeRegistry
from connector.runtimes.codex.sdk.events import CodexSdkEvent


@dataclass(slots=True)
class CodexPlanReviewHandler:
    host: RuntimeHostClient
    session_states: RuntimeSessionStateCache
    notices: CodexNoticeRegistry
    pending_plans: dict[tuple[str, str], str] = field(default_factory=dict)

    def has_review(self, thread_id: str, turn_id: str | None) -> bool:
        return self.notices.get(f"notice_codex_plan_{thread_id}_{turn_id}") is not None

    async def handle(self, session_id: str, thread_id: str, turn_id: str | None, event: CodexSdkEvent) -> None:
        if event.event_type == "item/completed" and event.item_type == "plan" and event.turn_id and isinstance(event.content, str):
            self.pending_plans[(thread_id, event.turn_id)] = event.content
        if event.is_turn_started:
            for notice in self.notices.current_for_session(session_id):
                if notice.source.get("component") == "codex.plan_review" and notice.status == "open":
                    closed = self.notices.transition(notice.notice_id, status="closed", response_required=False, blocking=None, actions=())
                    await self.host.notice_upsert(closed)
        if event.is_terminal_turn or event.is_failed_turn:
            plan = self.pending_plans.pop((thread_id, turn_id), None)
            if event.event_type == "turn/completed" and plan and plan.strip():
                notice_id = f"notice_codex_plan_{thread_id}_{turn_id}"
                if self.notices.get(notice_id) is None:
                    notice = SessionNotice(
                        notice_id=notice_id, session_id=session_id, runtime="codex", type="interaction",
                        title="Review plan", message=plan, severity="info", status="open",
                        interaction_type="approval", response_required=True,
                        blocking={"scope": "session", "targetId": session_id},
                        actions=({"actionId": "implement_plan", "label": "Approve and execute", "style": "primary"},
                                 {"actionId": "revise_plan", "label": "Continue planning", "style": "secondary"}),
                        source={"component": "codex.plan_review", "turnId": turn_id},
                        context={"threadId": thread_id},
                    )
                    self.notices.upsert(notice)
                    await self.host.notice_upsert(notice)
                    await self.session_states.update(session_id=session_id, external_session_id=thread_id,
                                                     status="waiting_approval", metadata={"source": "codex.plan_review"})
