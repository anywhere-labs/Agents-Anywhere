from __future__ import annotations

import hashlib
import json

from agent_server.core.models import SessionView
from agent_server.core.planning.models import (
    PlanDocument,
    PlanningRequest,
    PlanningResponse,
    PlanningState,
)
from agent_server.services.planning.ports import PlanningGateway, PlanningRepository


class PlanningService:
    def __init__(self, repository: PlanningRepository, gateway: PlanningGateway):
        self.repository, self.gateway = repository, gateway

    @staticmethod
    def scope(session: SessionView) -> dict:
        return {
            "sessionId": session.id,
            "runtime": session.runtime,
            "runtimeId": session.runtimeId,
            "externalSessionId": session.externalSessionId,
            "controlAllowed": session.takeover and not session.archived,
        }

    async def read(self, session: SessionView) -> PlanningState:
        try:
            raw = await self.gateway.request(
                session.connectorId,
                "session.planning.get",
                self.scope(session),
                timeout=10,
            )
            state = PlanningState.model_validate(
                {
                    **raw,
                    "sessionId": session.id,
                    "runtime": session.runtime,
                    "runtimeId": session.runtimeId,
                }
            )
        except (RuntimeError, TimeoutError, ValueError, TypeError):
            saved = await self.repository.read_planning(session.id) or {
                "sessionId": session.id,
                "runtime": session.runtime,
            }
            saved.update(
                freshness="stale",
                capabilities={
                    "supported": False,
                    "actions": [],
                    "reason": "原生状态暂不可用；已保存的计划仍可查阅。",
                },
            )
            state = PlanningState.model_validate(saved)
        else:
            if not session.takeover or session.archived:
                state.capabilities = state.capabilities.model_copy(
                    update={"actions": [], "reason": "请先接管有效会话。"}
                )
            await self.repository.save_planning(
                session.id, state.model_dump(mode="json")
            )
        state.proposals = [
            PlanDocument.model_validate(document)
            for document in await self.repository.list_plan_documents(session.id)
        ]
        return state

    async def operation(
        self, session: SessionView, operation_id: str
    ) -> PlanningResponse | None:
        saved = await self.repository.get_planning_operation(session.id, operation_id)
        if saved is None:
            return None
        if saved.get("outcome") == "unknown":
            try:
                raw = await self.gateway.request(
                    session.connectorId,
                    "session.planning.operation",
                    {**self.scope(session), "operationId": operation_id},
                    timeout=10,
                )
                if isinstance(raw, dict) and isinstance(raw.get("operation"), dict):
                    current = PlanningResponse.model_validate(raw["operation"])
                    if (
                        current.operationId == operation_id
                        and current.outcome != "unknown"
                    ):
                        saved = current.model_dump(mode="json")
                        await self.repository.save_planning_operation(
                            session.id, operation_id, saved
                        )
            except (RuntimeError, TimeoutError, ValueError, TypeError):
                pass  # Reading a receipt never redispatches the operation.
        return PlanningResponse.model_validate(saved)

    async def execute(
        self, session: SessionView, payload: PlanningRequest, *, user_id: str
    ) -> PlanningResponse:
        request = payload.model_dump(mode="json", exclude_none=True)
        request["attachments"] = []
        for ref in payload.attachments:
            metadata = await self.repository.read_uploaded_file(
                session_id=session.id, file_id=ref["fileId"], user_id=user_id
            )
            request["attachments"].append(
                {
                    key: metadata.get(key)
                    for key in ("fileId", "name", "mediaType", "size", "sha256")
                }
            )
        fingerprint = hashlib.sha256(
            json.dumps(request, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()
        previous = await self.repository.reserve_planning_operation(
            session.id, payload.operationId, fingerprint
        )
        if previous is not None:
            return PlanningResponse.model_validate(previous)
        try:
            raw = await self.gateway.request(
                session.connectorId,
                "session.planning.execute",
                {**self.scope(session), "request": request},
                timeout=30,
            )
            result = PlanningResponse.model_validate(raw)
            if result.operationId != payload.operationId:
                raise ValueError("Native operation identity mismatch")
        except (RuntimeError, TimeoutError, ValueError, TypeError):
            result = PlanningResponse(
                operationId=payload.operationId,
                outcome="unknown",
                ok=False,
                code="command_outcome_unknown",
                message="原生操作结果尚不确定，请刷新状态；请勿重复执行。",
                execution="unknown",
            )
        await self.repository.save_planning_operation(
            session.id, payload.operationId, result.model_dump(mode="json")
        )
        return result
