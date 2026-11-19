"""Agent collaboration routes the Server owns (``core.agent_collab``, ``services.agent_collab``).

``GET/PUT /api/v2/agent-collaboration/settings``: the account's collaboration settings (user access token).
``POST /api/v3/device/agent-delegations``: a delegation token for an Agent of the calling device (device access
token). ``DELETE /api/v3/device/agent-delegations/{grantId}``: revoke every delegation of a grant.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException
from starlette.requests import HTTPConnection

from agent_server.api.connector_ingress import _require_active_connector
from agent_server.api.device_link import V3_DEVICE_PREFIX
from agent_server.core.agent_collab import (
    AgentCollaborationSettings,
    AgentDelegationRequest,
    AgentDelegationResponse,
    AgentDelegationRevokeResponse,
    ReviewAdmission,
    ReviewAdmissionRequest,
)
from agent_server.deps import current_user_id, get_store
from agent_server.infra.repositories.facade import Store
from agent_server.services.agent_collab import CollabError, CollabService

router = APIRouter(prefix="/agent-collaboration", tags=["agent-collaboration"])
device_router = APIRouter(prefix=V3_DEVICE_PREFIX, tags=["agent-collaboration"])


def get_collab(conn: HTTPConnection) -> CollabService:
    return conn.app.state.collab


Collab = Annotated[CollabService, Depends(get_collab)]


def _raise(exc: CollabError) -> None:
    raise HTTPException(status_code=exc.status, detail=exc.detail()) from exc


@router.get("/settings", response_model=AgentCollaborationSettings)
async def get_agent_collaboration_settings(
    user_id: Annotated[str, Depends(current_user_id)],
    collab: Collab,
) -> AgentCollaborationSettings:
    try:
        return await collab.get_settings(user_id)
    except KeyError:
        raise HTTPException(status_code=401, detail="user no longer exists") from None


@router.put("/settings", response_model=AgentCollaborationSettings)
async def put_agent_collaboration_settings(
    payload: AgentCollaborationSettings,
    user_id: Annotated[str, Depends(current_user_id)],
    collab: Collab,
) -> AgentCollaborationSettings:
    try:
        return await collab.update_settings(user_id, payload)
    except CollabError as exc:
        _raise(exc)
    except KeyError:
        raise HTTPException(status_code=401, detail="user no longer exists") from None


@device_router.post("/agent-delegations", response_model=AgentDelegationResponse)
async def issue_agent_delegation(
    payload: AgentDelegationRequest,
    db: Annotated[Store, Depends(get_store)],
    collab: Collab,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> AgentDelegationResponse:
    device_id = await _require_active_connector(authorization, db)
    try:
        return await collab.issue_delegation(device_id, payload)
    except CollabError as exc:
        _raise(exc)
    raise AssertionError("unreachable")


@device_router.delete("/agent-delegations/{grant_id}", response_model=AgentDelegationRevokeResponse)
async def revoke_agent_delegations(
    grant_id: str,
    db: Annotated[Store, Depends(get_store)],
    collab: Collab,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> AgentDelegationRevokeResponse:
    device_id = await _require_active_connector(authorization, db)
    return AgentDelegationRevokeResponse(grantId=grant_id, revoked=await collab.revoke_grant(device_id, grant_id))

@device_router.post("/a2a-review-admission", response_model=ReviewAdmission)
async def authorize_review_execution(
    payload: ReviewAdmissionRequest,
    db: Annotated[Store, Depends(get_store)],
    collab: Collab,
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> ReviewAdmission:
    device_id = await _require_active_connector(authorization, db)
    try:
        return await collab.review_admission(device_id, payload)
    except CollabError as exc:
        _raise(exc)
    raise AssertionError("unreachable")
