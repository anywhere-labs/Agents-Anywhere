"""Plans and goals of sessions on v3 devices live on the device (``05-server.md`` §2, D1).

The routes go to the device with ``Client/call``. The Server keeps only the two directory enums
``plan_state`` / ``goal_state`` (for lists and for offline display) and the command receipts:

- **Offline**: the Server answers a ``stale`` state built from the directory enum.
- **Operations**: ``GET .../operations/{operationId}`` reads the command receipt: the outcome and error code
  only (the receipt keeps no ``r``, D1); the state after an applied operation is read from the device.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import BaseModel, ValidationError

from agent_server.core.goal.models import GoalResponse
from agent_server.core.planning.models import PlanningResponse
from agent_server.services.device_commands import DeviceCommandService
from agent_server.services.device_reads import DeviceReadError

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
    def __init__(self, store: Any, commands: DeviceCommandService) -> None:
        self._store = store
        self._commands = commands

    async def operation(
        self,
        session: Any,
        kind: str,
        operation_id: str,
        *,
        user_id: str,
        forwarded: str,
        current_state: Callable[[], Awaitable[dict[str, Any]]],
    ) -> BaseModel | None:
        """The outcome of a planning or goal operation, from its receipt.

        ``forwarded``: the client route whose receipts ``Client/call`` leaves for the same operations
        (``session.planning.execute``); ``current_state``: how the state after an applied operation is read.
        """

        receipt = await self._store.get_device_command(user_id, operation_id)
        kinds = {kind, forwarded}
        if receipt is None or receipt["kind"] not in kinds or receipt.get("sessionId") != session.id:
            return None
        if receipt["state"] in ("pending", "unknown"):
            receipt = await self._commands.reconcile_one(receipt, settle_unseen=False) or receipt
        result = receipt.get("result") or {}
        if receipt["state"] == "accepted":
            state = await current_state()
            body = _accepted(operation_id, {**(result.get("r") or {}), **state})
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
