from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from agent_server.api.sessions import _require_session_action_capability
from agent_server.core.goal.models import GoalRequest, GoalResponse, GoalState
from agent_server.deps import current_user_id, get_rpc, get_store
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.repositories.facade import Store
from agent_server.services.goal.service import GoalService

router = APIRouter(prefix="/sessions", tags=["goals"])


async def owned(db, sid, uid):
    try:
        return await db.get_session(sid, user_id=uid)
    except KeyError:
        raise HTTPException(404, "session not found") from None


@router.get("/{session_id}/goal", response_model=GoalState)
async def read_goal(
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    rpc: Annotated[ConnectorRpcManager, Depends(get_rpc)],
):
    return await GoalService(db, rpc).read(await owned(db, session_id, user_id))


@router.post("/{session_id}/goal", response_model=GoalResponse)
async def execute_goal(
    session_id: str,
    payload: GoalRequest,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    rpc: Annotated[ConnectorRpcManager, Depends(get_rpc)],
):
    session = await owned(db, session_id, user_id)
    try:
        replay = await GoalService(db, rpc).replay(session, payload, user_id=user_id)
        if replay is not None:
            return replay
    except ValueError as error:
        raise HTTPException(409, str(error)) from error
    except KeyError:
        raise HTTPException(404, "attachment not found") from None
    if session.archived or not session.takeover:
        raise HTTPException(409, "goal_control_not_allowed")
    await _require_session_action_capability(
        db, rpc, session, "session.goal", user_id=user_id
    )
    if payload.attachments:
        await _require_session_action_capability(
            db, rpc, session, "runtime.attachment", user_id=user_id
        )
    try:
        return await GoalService(db, rpc).execute(session, payload, user_id=user_id)
    except KeyError:
        raise HTTPException(404, "attachment not found") from None
    except ValueError as e:
        raise HTTPException(409, str(e)) from e


@router.get("/{session_id}/goal/operations/{operation_id}", response_model=GoalResponse)
async def goal_operation(
    session_id: str,
    operation_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    rpc: Annotated[ConnectorRpcManager, Depends(get_rpc)],
):
    result = await GoalService(db, rpc).operation(
        await owned(db, session_id, user_id), operation_id
    )
    if result is None:
        raise HTTPException(404, "goal operation not found")
    return result
