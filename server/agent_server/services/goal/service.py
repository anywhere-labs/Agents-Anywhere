from __future__ import annotations

from agent_server.core.goal.models import GoalRequest, GoalResponse, GoalState
from agent_server.core.models import SessionView
from agent_server.services.goal.ports import GoalGateway, GoalRepository


class GoalService:
    def __init__(self, repository: GoalRepository, gateway: GoalGateway):
        self.repository, self.gateway = repository, gateway

    @staticmethod
    def scope(s: SessionView):
        return {
            "sessionId": s.id,
            "runtime": s.runtime,
            "runtimeId": s.runtimeId,
            "externalSessionId": s.externalSessionId,
            "controlAllowed": s.takeover and not s.archived,
        }

    async def read(self, s: SessionView):
        try:
            raw = await self.gateway.request(
                s.connectorId, "session.goal.get", self.scope(s), timeout=10
            )
            value = GoalState.model_validate(
                {
                    **raw,
                    "sessionId": s.id,
                    "runtime": s.runtime,
                    "runtimeId": s.runtimeId,
                }
            )
            existing = await self.repository.read_goal(s.id)
            if existing or value.goal or value.lastOutcome:
                saved = await self.repository.save_goal(
                    s.id,
                    value.model_dump(mode="json"),
                    connector_id=s.connectorId,
                    reconcile=True,
                )
                value = GoalState.model_validate(saved)
            else:
                value.revision = 0
        except (RuntimeError, TimeoutError, ValueError, TypeError):
            saved = await self.repository.read_goal(s.id)
            value = GoalState.model_validate(
                {
                    **(saved or {}),
                    "sessionId": s.id,
                    "runtime": s.runtime,
                    "runtimeId": s.runtimeId,
                    "freshness": "stale" if saved else "unknown",
                    "capabilities": {
                        "supported": bool(saved),
                        "actions": [],
                        "reason": "goal_state_unavailable",
                    },
                }
            )
        value.pendingOperationId = await self.repository.pending_goal_operation(s.id)
        if value.pendingOperationId:
            value.capabilities.actions = []
        if not s.takeover or s.archived:
            value.capabilities.actions = []
        return value

    async def prepare_request(
        self, s: SessionView, payload: GoalRequest, *, user_id: str
    ):
        request = payload.model_dump(mode="json", exclude_none=True)
        request["attachments"] = []
        for ref in payload.attachments:
            metadata = await self.repository.read_uploaded_file(
                session_id=s.id, file_id=ref["fileId"], user_id=user_id
            )
            request["attachments"].append(
                {
                    k: metadata.get(k)
                    for k in ("fileId", "name", "mediaType", "size", "sha256")
                }
            )
        return request

    async def replay(self, s: SessionView, payload: GoalRequest, *, user_id: str):
        request = await self.prepare_request(s, payload, user_id=user_id)
        result = await self.repository.replay_goal_operation(s.id, request)
        return GoalResponse.model_validate(result) if result else None

    async def execute(self, s: SessionView, payload: GoalRequest, *, user_id: str):
        request = await self.prepare_request(s, payload, user_id=user_id)
        previous = await self.repository.reserve_goal_operation(
            s.id,
            request,
            binding={
                "connectorId": s.connectorId,
                "runtimeId": s.runtimeId,
                "runtime": s.runtime,
                "externalSessionId": s.externalSessionId,
            },
        )
        if previous:
            return GoalResponse.model_validate(previous)
        state = await self.repository.read_goal(s.id)
        if state is None:
            try:
                observed = await self.read(s)
                if observed.freshness != "fresh":
                    raise ValueError("goal_state_unavailable")
                state = await self.repository.save_goal(
                    s.id,
                    observed.model_dump(mode="json"),
                    connector_id=s.connectorId,
                    reconcile=True,
                )
            except (RuntimeError, TimeoutError, ValueError, TypeError):
                result = GoalResponse(
                    operationId=payload.operationId,
                    ok=False,
                    outcome="rejected",
                    code="goal_state_unavailable",
                )
                await self.repository.save_goal_operation(
                    s.id, result.model_dump(mode="json")
                )
                return result
        native = {
            **request,
            "sourceEpoch": (state or {}).get("sourceEpoch", ""),
            "sourceRevision": (state or {}).get("sourceRevision", 0),
        }
        await self.repository.mark_goal_dispatched(s.id, payload.operationId)
        try:
            raw = await self.gateway.request(
                s.connectorId,
                "session.goal.execute",
                {**self.scope(s), "request": native},
                timeout=30,
            )
            result = GoalResponse.model_validate(raw)
            if result.operationId != payload.operationId:
                raise ValueError("goal_operation_identity_mismatch")
            if result.state:
                saved = await self.repository.save_goal(
                    s.id,
                    result.state.model_dump(mode="json"),
                    connector_id=s.connectorId,
                    operation=result.model_dump(mode="json"),
                )
                result.state = GoalState.model_validate(saved)
            else:
                await self.repository.save_goal_operation(
                    s.id, result.model_dump(mode="json")
                )
        except (RuntimeError, TimeoutError, ValueError, TypeError):
            result = GoalResponse(
                operationId=payload.operationId,
                ok=False,
                outcome="unknown",
                code="goal_outcome_unknown",
            )
            await self.repository.save_goal_operation(
                s.id, result.model_dump(mode="json")
            )
        return result

    async def operation(self, s: SessionView, oid: str):
        saved = await self.repository.get_goal_operation(s.id, oid)
        if saved is None:
            return None
        if saved["outcome"] in {"pending", "unknown"}:
            try:
                raw = await self.gateway.request(
                    s.connectorId,
                    "session.goal.operation",
                    {**self.scope(s), "operationId": oid},
                    timeout=10,
                )
                if raw.get("operation"):
                    result = GoalResponse.model_validate(raw["operation"])
                    if result.operationId != oid:
                        raise ValueError("goal_operation_identity_mismatch")
                    if result.state:
                        fresh = await self.repository.save_goal(
                            s.id,
                            result.state.model_dump(mode="json"),
                            connector_id=s.connectorId,
                            operation=result.model_dump(mode="json"),
                        )
                        result.state = GoalState.model_validate(fresh)
                    else:
                        await self.repository.save_goal_operation(
                            s.id, result.model_dump(mode="json")
                        )
                    return result
            except (RuntimeError, TimeoutError, ValueError, TypeError):
                pass
        return GoalResponse.model_validate(saved)
