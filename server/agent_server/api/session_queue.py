"""The in-run message queue. It lives on the device (v3): every route goes to it with ``Client/call``.

Messages enter the queue through ``POST /sessions/{id}/runtime/messages`` with
``queue: "auto" | "interrupt"``; these routes read and change what waits.
Fixed paths (``resume``, ``order``) are declared before ``{message_id}``.
Sessions on v2 Connectors never get here (``V3_SESSION_ONLY``).
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request

from agent_server.api.client_forward import forward_session
from agent_server.api.v2_compat import V3_SESSION_ONLY
from agent_server.core.message_queue import (
    QueueItemUpdateRequest,
    QueueOrderRequest,
    SessionQueueState,
)
from agent_server.core.models import SessionView
from agent_server.core.protocol_v1_2 import SessionQueueStateV12
from agent_server.deps import current_user_id

router = APIRouter(prefix="/sessions", tags=["session-queue"])


async def _offline_queue(session: SessionView) -> dict[str, Any]:
    """An offline device's queue: empty, marked ``deviceOffline``."""

    return {"sessionId": session.id, "revision": 0, "items": [], "deviceOffline": True}


UserId = Annotated[str, Depends(current_user_id)]


@router.get("/{session_id}/runtime/queue", response_model=SessionQueueStateV12, dependencies=V3_SESSION_ONLY)
async def read_queue(request: Request, session_id: str, user_id: UserId) -> SessionQueueStateV12:
    return await forward_session(  # type: ignore[return-value]
        request, "session.runtime.queue", user_id=user_id, session_id=session_id, response_model=SessionQueueStateV12, offline=_offline_queue
    )


@router.delete("/{session_id}/runtime/queue", response_model=SessionQueueState, dependencies=V3_SESSION_ONLY)
async def clear_queue(request: Request, session_id: str, user_id: UserId) -> SessionQueueState:
    return await forward_session(  # type: ignore[return-value]
        request, "session.runtime.queue.clear", user_id=user_id, session_id=session_id, response_model=SessionQueueState
    )


@router.post("/{session_id}/runtime/queue/resume", response_model=SessionQueueState, dependencies=V3_SESSION_ONLY)
async def resume_queue(request: Request, session_id: str, user_id: UserId) -> SessionQueueState:
    return await forward_session(  # type: ignore[return-value]
        request, "session.runtime.queue.resume", user_id=user_id, session_id=session_id, response_model=SessionQueueState
    )


@router.put("/{session_id}/runtime/queue/order", response_model=SessionQueueState, dependencies=V3_SESSION_ONLY)
async def reorder_queue(
    request: Request, session_id: str, payload: QueueOrderRequest, user_id: UserId
) -> SessionQueueState:
    return await forward_session(  # type: ignore[return-value]
        request, "session.runtime.queue.reorder", user_id=user_id, session_id=session_id, response_model=SessionQueueState
    )


@router.delete(
    "/{session_id}/runtime/queue/{message_id}", response_model=SessionQueueState, dependencies=V3_SESSION_ONLY
)
async def delete_queue_item(request: Request, session_id: str, message_id: str, user_id: UserId) -> SessionQueueState:
    return await forward_session(  # type: ignore[return-value]
        request, "session.runtime.queue.delete", user_id=user_id, session_id=session_id, response_model=SessionQueueState
    )


@router.post(
    "/{session_id}/runtime/queue/{message_id}/retry", response_model=SessionQueueState, dependencies=V3_SESSION_ONLY
)
async def retry_queue_item(request: Request, session_id: str, message_id: str, user_id: UserId) -> SessionQueueState:
    return await forward_session(  # type: ignore[return-value]
        request, "session.runtime.queue.retry", user_id=user_id, session_id=session_id, response_model=SessionQueueState
    )


@router.post(
    "/{session_id}/runtime/queue/{message_id}/send-now",
    response_model=SessionQueueState,
    dependencies=V3_SESSION_ONLY,
)
async def send_queue_item_now(
    request: Request, session_id: str, message_id: str, user_id: UserId
) -> SessionQueueState:
    return await forward_session(  # type: ignore[return-value]
        request, "session.runtime.queue.sendNow", user_id=user_id, session_id=session_id, response_model=SessionQueueState
    )


@router.patch(
    "/{session_id}/runtime/queue/{message_id}", response_model=SessionQueueState, dependencies=V3_SESSION_ONLY
)
async def update_queue_item(
    request: Request, session_id: str, message_id: str, payload: QueueItemUpdateRequest, user_id: UserId
) -> SessionQueueState:
    return await forward_session(  # type: ignore[return-value]
        request, "session.runtime.queue.update", user_id=user_id, session_id=session_id, response_model=SessionQueueState
    )
