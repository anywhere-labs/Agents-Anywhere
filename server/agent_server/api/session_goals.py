"""Session goals. They live on the device (v3, D1): every route goes to it with ``Client/call``; the Server
keeps the operation receipts (``services.device_planning``).

Sessions on v2 Connectors never get here (``V3_SESSION_ONLY``).
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request

from agent_server.api.client_forward import forward_session, owned_session
from agent_server.api.session_planning import (
    DevicePlanning,
    _facts,
    forwarded_operation,
)
from agent_server.api.v2_compat import V3_SESSION_ONLY
from agent_server.core.goal.models import GoalRequest, GoalResponse, GoalState
from agent_server.core.models import SessionView
from agent_server.deps import current_user_id
from agent_server.services.device_planning import offline_goal_state

router = APIRouter(prefix="/sessions", tags=["goals"])


@router.get("/{session_id}/goal", response_model=GoalState, dependencies=V3_SESSION_ONLY)
async def read_goal(
    request: Request,
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
):
    async def stale(session: SessionView) -> dict[str, Any]:
        return offline_goal_state(session)

    return await forward_session(
        request, "session.goal.get", user_id=user_id, session_id=session_id, response_model=GoalState,
        offline=stale,
    )


@router.post("/{session_id}/goal", response_model=GoalResponse, dependencies=V3_SESSION_ONLY)
async def execute_goal(
    request: Request,
    session_id: str,
    payload: GoalRequest,
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await forward_session(
        request, "session.goal.execute", user_id=user_id, session_id=session_id, response_model=GoalResponse,
        server=_facts,
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
    device: DevicePlanning,
):
    session = await owned_session(request, user_id=user_id, session_id=session_id)
    result = await forwarded_operation(request, device, session, "session.goal", operation_id, user_id)
    if result is None:
        raise HTTPException(404, "goal operation not found")
    return result
