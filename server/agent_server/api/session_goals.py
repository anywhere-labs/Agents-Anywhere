"""Session goals. They live on the device (v3, D1); see ``services.device_planning``.

Sessions on v2 Connectors never get here (``V3_SESSION_ONLY``).
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request

from agent_server.api.client_forward import forward_session, owned_session
from agent_server.api.session_planning import DevicePlanning, forwarded_operation, owned
from agent_server.api.sessions import _require_session_action_capability
from agent_server.api.v2_compat import V3_SESSION_ONLY
from agent_server.core.capabilities import RUNTIME_ATTACHMENT, SESSION_GOAL
from agent_server.core.goal.models import GoalRequest, GoalResponse, GoalState
from agent_server.deps import current_user_id, get_rpc, get_store
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.repositories.facade import Store

router = APIRouter(prefix="/sessions", tags=["goals"])


@router.get("/{session_id}/goal", response_model=GoalState, dependencies=V3_SESSION_ONLY)
async def read_goal(
    request: Request,
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    device: DevicePlanning,
):
    if (forwarded := await forward_session(
        request, "session.goal.get", user_id=user_id, session_id=session_id, response_model=GoalState
    )) is not None:
        return forwarded
    session = await owned(db, session_id, user_id)
    return await device.call(device.service.goal_state(session))


@router.post("/{session_id}/goal", response_model=GoalResponse, dependencies=V3_SESSION_ONLY)
async def execute_goal(
    request: Request,
    session_id: str,
    payload: GoalRequest,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    rpc: Annotated[ConnectorRpcManager, Depends(get_rpc)],
    device: DevicePlanning,
):
    if (forwarded := await forward_session(
        request, "session.goal.execute", user_id=user_id, session_id=session_id, response_model=GoalResponse
    )) is not None:
        return forwarded
    session = await owned(db, session_id, user_id)
    if session.archived or not session.takeover:
        raise HTTPException(409, "goal_control_not_allowed")
    await _require_session_action_capability(db, rpc, session, SESSION_GOAL, user_id=user_id)
    if payload.attachments:
        await _require_session_action_capability(db, rpc, session, RUNTIME_ATTACHMENT, user_id=user_id)
    return await device.call(
        device.service.execute(
            session, "session.goal", payload.model_dump(mode="json", exclude_none=True), user_id=user_id
        )
    )


@router.get(
    "/{session_id}/goal/operations/{operation_id}",
    response_model=GoalResponse,
    dependencies=V3_SESSION_ONLY,
)
async def goal_operation(
    request: Request,
    session_id: str,
    operation_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    device: DevicePlanning,
):
    if (session := await owned_session(
        request, "session.goal.operation", user_id=user_id, session_id=session_id
    )) is not None:
        result = await forwarded_operation(request, device, session, "session.goal", operation_id, user_id)
        if result is None:
            raise HTTPException(404, "goal operation not found")
        return result
    session = await owned(db, session_id, user_id)
    result = await device.call(device.service.operation(session, "session.goal", operation_id, user_id=user_id))
    if result is None:
        raise HTTPException(404, "goal operation not found")
    return result
