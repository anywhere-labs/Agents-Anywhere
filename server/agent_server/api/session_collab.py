"""A session's agent collaboration (``/sessions/{id}/collab``): its supervisions and grant, answered by the
session's device with ``Client/call``.

The device owns triggers, authority and digests; the Server keeps only the supervision edges the device reports
(``collab.supervision.changed``), shown on session views.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends, Request

from agent_server.api.client_forward import forward_session, session_facts
from agent_server.api.v2_compat import V3_SESSION_ONLY
from agent_server.core.device_meshcall import ClientServerFacts
from agent_server.core.models import SessionView
from agent_server.deps import current_user_id

router = APIRouter(prefix="/sessions", tags=["agent-collaboration"])


async def _facts(session: SessionView) -> ClientServerFacts:
    return session_facts(session)


@router.get("/{session_id}/collab", dependencies=V3_SESSION_ONLY)
async def get_session_collab(
    request: Request,
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
):
    return await forward_session(request, "session.collab.get", user_id=user_id, session_id=session_id)


@router.post("/{session_id}/collab/supervisions", dependencies=V3_SESSION_ONLY)
async def create_session_supervision(
    request: Request,
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    _payload: Annotated[dict[str, Any], Body()],
):
    return await forward_session(
        request, "session.collab.supervise", user_id=user_id, session_id=session_id, server=_facts
    )


@router.patch("/{session_id}/collab/supervisions/{supervision_id}", dependencies=V3_SESSION_ONLY)
async def update_session_supervision(
    request: Request,
    session_id: str,
    supervision_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    _payload: Annotated[dict[str, Any], Body()],
):
    return await forward_session(
        request, "session.collab.supervision.update", user_id=user_id, session_id=session_id, server=_facts
    )
