from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response

from agent_server.api.sessions import _require_session_action_capability
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
from agent_server.deps import current_user_id, get_rpc, get_store
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.repositories.facade import Store
from agent_server.services.planning.service import PlanningService

router = APIRouter(prefix="/sessions", tags=["planning"])


async def owned(db, session_id, user_id):
    try:
        return await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(404, "session not found") from None


@router.get("/{session_id}/planning", response_model=PlanningState)
async def get_planning(
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    rpc: Annotated[ConnectorRpcManager, Depends(get_rpc)],
):
    session = await owned(db, session_id, user_id)
    return await PlanningService(db, rpc).read(session)


@router.post("/{session_id}/planning", response_model=PlanningResponse)
async def execute_planning(
    session_id: str,
    payload: PlanningRequest,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    rpc: Annotated[ConnectorRpcManager, Depends(get_rpc)],
):
    session = await owned(db, session_id, user_id)
    if session.archived:
        raise HTTPException(409, "会话已归档。")
    await _require_session_action_capability(
        db, rpc, session, SESSION_PLANNING, user_id=user_id
    )
    if payload.command in {"approve_and_execute", "request_revision", "dismiss_review"}:
        await _require_session_action_capability(
            db, rpc, session, SESSION_PLAN_REVIEW, user_id=user_id
        )
    if payload.attachments:
        await _require_session_action_capability(
            db, rpc, session, RUNTIME_ATTACHMENT, user_id=user_id
        )
    try:
        return await PlanningService(db, rpc).execute(session, payload, user_id=user_id)
    except KeyError:
        raise HTTPException(404, "attachment not found") from None
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get(
    "/{session_id}/planning/operations/{operation_id}", response_model=PlanningResponse
)
async def read_operation(
    session_id: str,
    operation_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
    rpc: Annotated[ConnectorRpcManager, Depends(get_rpc)],
):
    session = await owned(db, session_id, user_id)
    result = await PlanningService(db, rpc).operation(session, operation_id)
    if result is None:
        raise HTTPException(404, "planning operation not found")
    return result


@router.get("/{session_id}/plans", response_model=list[PlanDocument])
async def list_plans(
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
):
    await owned(db, session_id, user_id)
    return await db.list_plan_documents(session_id)


@router.get("/{session_id}/plans/{plan_id}/{revision}", response_model=PlanDocument)
async def read_plan(
    session_id: str,
    plan_id: str,
    revision: int,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
):
    await owned(db, session_id, user_id)
    try:
        return await db.get_plan_document(session_id, plan_id, revision)
    except KeyError:
        raise HTTPException(404, "plan not found") from None


@router.get("/{session_id}/plans/{plan_id}/{revision}/markdown")
async def download_plan(
    session_id: str,
    plan_id: str,
    revision: int,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
):
    plan = await read_plan(session_id, plan_id, revision, user_id, db)
    return Response(
        plan["markdown"],
        media_type="text/markdown; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="PLAN.md"'},
    )
