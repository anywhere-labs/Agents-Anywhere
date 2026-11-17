"""Session planning and plan documents. They live on the device (v3, D1); see
``services.device_planning``. Sessions on v2 Connectors never get here
(``V3_SESSION_ONLY``).
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from agent_server.api.device_session_reads import device_read_http_error
from agent_server.api.sessions import _require_session_action_capability
from agent_server.api.v2_compat import V3_SESSION_ONLY
from agent_server.core.capabilities import (
    RUNTIME_ATTACHMENT,
    SESSION_PLAN_REVIEW,
    SESSION_PLANNING,
)
from agent_server.core.planning.models import (
    PlanDocument,
    PlanningRequest,
    PlanningResponse,
    PlanningState,
)
from agent_server.deps import current_user_id, get_device_planning, get_rpc, get_store
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.repositories.facade import Store
from agent_server.services.device_planning import (
    DevicePlanningService,
    DevicePlanningUnavailable,
    DevicePlanNotFound,
)
from agent_server.services.device_reads import DeviceReadError, DeviceReadTimeout

router = APIRouter(prefix="/sessions", tags=["planning"])


class DevicePlanningRoute:
    """Plans and goals are the device's: map its failures to HTTP errors."""

    def __init__(self, service: Annotated[DevicePlanningService, Depends(get_device_planning)]) -> None:
        self.service = service

    async def call(self, work):
        try:
            return await work
        except DevicePlanningUnavailable:
            raise HTTPException(
                409, {"code": "connector_offline", "message": "the device is offline"}
            ) from None
        except DevicePlanNotFound:
            raise HTTPException(404, "plan not found") from None
        except (DeviceReadTimeout, DeviceReadError) as exc:
            raise device_read_http_error(exc) from exc


DevicePlanning = Annotated[DevicePlanningRoute, Depends()]


async def owned(db, session_id, user_id):
    try:
        return await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(404, "session not found") from None


@router.get("/{session_id}/planning", response_model=PlanningState, dependencies=V3_SESSION_ONLY)
async def get_planning(
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    device: DevicePlanning,
):
    session = await owned(db, session_id, user_id)
    return await device.call(device.service.planning_state(session))


@router.post("/{session_id}/planning", response_model=PlanningResponse, dependencies=V3_SESSION_ONLY)
async def execute_planning(
    session_id: str,
    payload: PlanningRequest,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    rpc: Annotated[ConnectorRpcManager, Depends(get_rpc)],
    device: DevicePlanning,
):
    session = await owned(db, session_id, user_id)
    if session.archived:
        raise HTTPException(409, "会话已归档。")
    await _require_session_action_capability(db, rpc, session, SESSION_PLANNING, user_id=user_id)
    if payload.command in {"approve_and_execute", "request_revision", "dismiss_review"}:
        await _require_session_action_capability(db, rpc, session, SESSION_PLAN_REVIEW, user_id=user_id)
    if payload.attachments:
        await _require_session_action_capability(db, rpc, session, RUNTIME_ATTACHMENT, user_id=user_id)
    return await device.call(
        device.service.execute(
            session, "session.planning", payload.model_dump(mode="json", exclude_none=True), user_id=user_id
        )
    )


@router.get(
    "/{session_id}/planning/operations/{operation_id}",
    response_model=PlanningResponse,
    dependencies=V3_SESSION_ONLY,
)
async def read_operation(
    session_id: str,
    operation_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    device: DevicePlanning,
):
    session = await owned(db, session_id, user_id)
    result = await device.call(device.service.operation(session, "session.planning", operation_id, user_id=user_id))
    if result is None:
        raise HTTPException(404, "planning operation not found")
    return result


@router.get("/{session_id}/plans", response_model=list[PlanDocument], dependencies=V3_SESSION_ONLY)
async def list_plans(
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    device: DevicePlanning,
):
    session = await owned(db, session_id, user_id)
    return await device.call(device.service.plan_documents(session))


@router.get(
    "/{session_id}/plans/{plan_id}/{revision}",
    response_model=PlanDocument,
    dependencies=V3_SESSION_ONLY,
)
async def read_plan(
    session_id: str,
    plan_id: str,
    revision: int,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    device: DevicePlanning,
):
    session = await owned(db, session_id, user_id)
    return await device.call(device.service.plan_document(session, plan_id, revision))


@router.get("/{session_id}/plans/{plan_id}/{revision}/markdown", dependencies=V3_SESSION_ONLY)
async def download_plan(
    session_id: str,
    plan_id: str,
    revision: int,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    device: DevicePlanning,
):
    plan = await read_plan(session_id, plan_id, revision, user_id, db, device)
    return Response(
        plan.markdown,
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="PLAN.md"'},
    )
