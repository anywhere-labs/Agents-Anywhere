"""Plans and goals of sessions on v3 devices live on the device (``05-server.md`` §2, D1).

The Server keeps only the two directory enums ``plan_state`` / ``goal_state`` (for
lists and for offline display). Everything else goes to the device:

- **State**: ``Sessions/state`` with ``{sessionId, part: "planning" | "goal"}``; the
  device answers ``{planning: PlanningState}`` / ``{goal: GoalState}`` in the v2
  client shapes. Offline, the Server answers a ``stale`` state built from the
  directory enum.
- **Plan documents**: ``Store/planDocument`` with ``{sessionId}`` -> ``{plans: [...]}``
  (newest first), or ``{sessionId, planId, revision}`` -> ``{plan: PlanDocument}``;
  ``plan_not_found`` when there is none.
- **Changes**: ``Commands/sessionPlanning`` / ``Commands/sessionGoal`` with the v2
  request body plus ``sessionId``; ``commandId = operationId``. ``CommandAck.r`` is
  the v2 response body (``PlanningResponse`` / ``GoalResponse`` fields).
- **Operations**: ``GET .../operations/{operationId}`` reads the command receipt.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ValidationError

from agent_server.core.goal.models import GoalResponse, GoalState
from agent_server.core.planning.models import (
    PlanDocument,
    PlanningResponse,
    PlanningState,
)
from agent_server.services.device_commands import (
    DeviceCommandError,
    DeviceCommandOffline,
    DeviceCommandOutcomeUnknown,
    DeviceCommandService,
    input_digest,
)
from agent_server.services.device_reads import DeviceReadError, DeviceReadService

PLAN_MODE = {"planning": "plan", "awaiting_review": "plan"}
RESPONSE_MODELS: dict[str, type[BaseModel]] = {"session.planning": PlanningResponse, "session.goal": GoalResponse}


def _validated(model: type[BaseModel], body: dict[str, Any]) -> BaseModel:
    """The device's answer in the v2 client shape; a malformed one is the device's fault (502)."""

    try:
        return model.model_validate(body)
    except ValidationError as exc:
        raise DeviceReadError(
            "device_response_invalid", f"the device answered an invalid {model.__name__}: {exc.errors()[:3]}"
        ) from exc


class DevicePlanningUnavailable(Exception):
    """Offline for a change (409 ``connector_offline``) or a document read."""


class DevicePlanNotFound(KeyError):
    pass


def offline_planning_state(session: Any, plan_state: str | None) -> dict[str, Any]:
    return {
        "sessionId": session.id,
        "runtime": session.runtime,
        "runtimeId": session.runtimeId,
        "effectiveMode": PLAN_MODE.get(plan_state or "none", "normal"),
        "freshness": "stale",
    }


def offline_goal_state(session: Any) -> dict[str, Any]:
    return {
        "sessionId": session.id,
        "runtime": session.runtime,
        "runtimeId": session.runtimeId,
        "externalSessionId": session.externalSessionId,
        "freshness": "stale",
    }


class DevicePlanningService:
    def __init__(self, store: Any, reads: DeviceReadService, commands: DeviceCommandService) -> None:
        self._store = store
        self._reads = reads
        self._commands = commands

    async def _directory(self, session_id: str) -> dict[str, Any]:
        return await self._store.session_directory_fields(session_id) or {}

    # -- state ----------------------------------------------------------------------

    async def planning_state(self, session: Any) -> BaseModel:
        body = await self._reads.read_method(
            session.connectorId, "session.state", {"sessionId": session.id, "part": "planning"}
        )
        if body is None:
            state = offline_planning_state(session, (await self._directory(session.id)).get("planState"))
        else:
            state = body.get("planning")
            if not isinstance(state, dict):
                state = offline_planning_state(session, None)
        return _validated(PlanningState, state)

    async def goal_state(self, session: Any) -> BaseModel:
        body = await self._reads.read_method(
            session.connectorId, "session.state", {"sessionId": session.id, "part": "goal"}
        )
        state = body.get("goal") if body is not None else None
        return _validated(GoalState, state if isinstance(state, dict) else offline_goal_state(session))

    # -- plan documents ----------------------------------------------------------------

    async def _plan_document(self, session: Any, params: dict[str, Any]) -> dict[str, Any]:
        try:
            body = await self._reads.read_method(
                session.connectorId, "store.planDocument", {"sessionId": session.id, **params}
            )
        except DeviceReadError as exc:
            if exc.code == "plan_not_found":
                raise DevicePlanNotFound(params.get("planId")) from exc
            raise
        if body is None:
            raise DevicePlanningUnavailable()
        return body

    async def plan_documents(self, session: Any) -> list[BaseModel]:
        plans = (await self._plan_document(session, {})).get("plans")
        if not isinstance(plans, list):
            return []
        return [_validated(PlanDocument, plan) for plan in plans if isinstance(plan, dict)]

    async def plan_document(self, session: Any, plan_id: str, revision: int) -> BaseModel:
        plan = (await self._plan_document(session, {"planId": plan_id, "revision": revision})).get("plan")
        if not isinstance(plan, dict):
            raise DevicePlanNotFound(plan_id)
        return _validated(PlanDocument, plan)

    # -- changes ------------------------------------------------------------------------

    async def execute(self, session: Any, kind: str, request: dict[str, Any], *, user_id: str) -> BaseModel:
        """Run ``session.planning`` / ``session.goal``; returns the v2 response body."""

        operation_id = request["operationId"]
        payload = {"sessionId": session.id, **request}
        try:
            outcome = await self._commands.send(
                user_id=user_id,
                device_id=session.connectorId,
                kind=kind,
                command_id=operation_id,
                payload=payload,
                session_id=session.id,
                digest=input_digest(kind, payload),
            )
        except DeviceCommandOffline as exc:
            raise DevicePlanningUnavailable() from exc
        except DeviceCommandOutcomeUnknown:
            body = _response(
                operation_id, "unknown", code="command_outcome_unknown", message="the device did not confirm the operation"
            )
        except DeviceCommandError as exc:
            body = _response(operation_id, "rejected", code=exc.code, message=exc.message)
        else:
            body = _accepted(operation_id, outcome.result)
        return _validated(RESPONSE_MODELS[kind], body)

    async def operation(self, session: Any, kind: str, operation_id: str, *, user_id: str) -> BaseModel | None:
        receipt = await self._store.get_device_command(user_id, operation_id)
        if receipt is None or receipt["kind"] != kind or receipt.get("sessionId") != session.id:
            return None
        if receipt["state"] in ("pending", "unknown"):
            receipt = await self._commands.reconcile_one(receipt, settle_unseen=False) or receipt
        result = receipt.get("result") or {}
        if receipt["state"] == "accepted":
            body = _accepted(operation_id, result.get("r") or {})
        elif receipt["state"] == "rejected":
            error = result.get("e") or {}
            body = _response(operation_id, "rejected", code=error.get("code"), message=error.get("message"))
        else:
            body = _response(operation_id, "pending" if receipt["state"] == "pending" else "unknown")
        return _validated(RESPONSE_MODELS[kind], body)


def _response(operation_id: str, outcome: str, *, code: str | None = None, message: str | None = None) -> dict[str, Any]:
    return {"operationId": operation_id, "outcome": outcome, "ok": False, "code": code, "message": message}


def _accepted(operation_id: str, result: dict[str, Any]) -> dict[str, Any]:
    """The device's ``r`` is the v2 response body; ``operationId`` is always the request's."""

    body = {"outcome": "applied", "ok": True, **(result if isinstance(result, dict) else {})}
    body["operationId"] = operation_id
    return body
