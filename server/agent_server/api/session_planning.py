"""Session planning and plan documents. They live on the device (v3, D1): every route goes to it with
``Client/call``; the Server keeps the operation receipts (``services.device_planning``). Sessions on v2
Connectors never get here (``V3_SESSION_ONLY``).
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import RootModel

from agent_server.api.client_forward import call as client_call
from agent_server.api.client_forward import (
    forward_session,
    owned_session,
    session_facts,
)
from agent_server.api.device_session_reads import device_read_http_error
from agent_server.api.v2_compat import V3_SESSION_ONLY
from agent_server.core.api_namespace import api_v2_path
from agent_server.core.device_meshcall import ClientServerFacts
from agent_server.core.models import SessionView
from agent_server.core.planning.models import (
    PlanDocument,
    PlanningRequest,
    PlanningResponse,
    PlanningState,
)
from agent_server.deps import current_user_id, get_device_planning, get_store
from agent_server.infra.repositories.facade import Store
from agent_server.services.device_planning import (
    DevicePlanningService,
    offline_planning_state,
)
from agent_server.services.device_reads import DeviceReadError

router = APIRouter(prefix="/sessions", tags=["planning"])


class PlanListAdapter(RootModel[list[PlanDocument]]):
    """``GET /plans`` checked as one model."""


DevicePlanning = Annotated[DevicePlanningService, Depends(get_device_planning)]


async def forwarded_state(request: Request, session: SessionView, route_id: str, user_id: str) -> dict[str, Any]:
    """``{"state": ...}`` read from the device with ``Client/call`` (empty when it answered an error)."""

    part = "planning" if route_id == "session.planning.get" else "goal"
    answer = await client_call(
        request, route_id, user_id=user_id, device_id=session.connectorId, session_id=session.id, body=None,
        path=api_v2_path(f"/sessions/{session.id}/{part}"), query={},
    )
    return {"state": answer.body} if answer.ok and isinstance(answer.body, dict) else {}


async def forwarded_operation(
    request: Request, device: DevicePlanningService, session: SessionView, kind: str, operation_id: str, user_id: str
) -> Any:
    """A planning or goal operation's outcome, from the receipt ``Client/call`` left."""

    execute, read = (
        ("session.planning.execute", "session.planning.get")
        if kind == "session.planning"
        else ("session.goal.execute", "session.goal.get")
    )
    try:
        return await device.operation(
            session,
            kind,
            operation_id,
            user_id=user_id,
            forwarded=execute,
            current_state=lambda: forwarded_state(request, session, read, user_id),
        )
    except DeviceReadError as exc:
        raise device_read_http_error(exc) from exc


async def _facts(session: SessionView) -> ClientServerFacts:
    return session_facts(session)


@router.get("/{session_id}/planning", response_model=PlanningState, dependencies=V3_SESSION_ONLY)
async def get_planning(
    request: Request,
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    db: Annotated[Store, Depends(get_store)],
):
    async def stale(session: SessionView) -> dict[str, Any]:
        fields = await db.session_directory_fields(session.id) or {}
        return offline_planning_state(session, fields.get("planState"))

    return await forward_session(
        request, "session.planning.get", user_id=user_id, session_id=session_id, response_model=PlanningState,
        offline=stale,
    )


@router.post("/{session_id}/planning", response_model=PlanningResponse, dependencies=V3_SESSION_ONLY)
async def execute_planning(
    request: Request,
    session_id: str,
    payload: PlanningRequest,
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await forward_session(
        request, "session.planning.execute", user_id=user_id, session_id=session_id, response_model=PlanningResponse,
        server=_facts,
    )


@router.get(
    "/{session_id}/planning/operations/{operation_id}",
    response_model=PlanningResponse,
    dependencies=V3_SESSION_ONLY,
)
async def read_operation(
    request: Request,
    session_id: str,
    operation_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    device: DevicePlanning,
):
    session = await owned_session(request, user_id=user_id, session_id=session_id)
    result = await forwarded_operation(request, device, session, "session.planning", operation_id, user_id)
    if result is None:
        raise HTTPException(404, "planning operation not found")
    return result


@router.get("/{session_id}/plans", response_model=list[PlanDocument], dependencies=V3_SESSION_ONLY)
async def list_plans(
    request: Request,
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await forward_session(
        request, "session.plans.list", user_id=user_id, session_id=session_id, response_model=PlanListAdapter
    )


@router.get(
    "/{session_id}/plans/{plan_id}/{revision}",
    response_model=PlanDocument,
    dependencies=V3_SESSION_ONLY,
)
async def read_plan(
    request: Request,
    session_id: str,
    plan_id: str,
    revision: int,
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await forward_session(
        request, "session.plans.get", user_id=user_id, session_id=session_id, response_model=PlanDocument
    )


@router.get("/{session_id}/plans/{plan_id}/{revision}/markdown", dependencies=V3_SESSION_ONLY)
async def download_plan(
    request: Request,
    session_id: str,
    plan_id: str,
    revision: int,
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await forward_session(
        request, "session.plans.markdown", user_id=user_id, session_id=session_id,
        headers={"Content-Disposition": 'attachment; filename="PLAN.md"'},
    )
