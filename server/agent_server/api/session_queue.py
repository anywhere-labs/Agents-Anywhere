"""REST surface of the server-owned session message queue.

Messages enter the queue through ``POST /sessions/{id}/runtime/messages`` with
``queue: "auto" | "interrupt"``; these routes read and change what waits.
Fixed paths (``resume``, ``order``) are declared before ``{message_id}``.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from agent_server.core.message_queue import (
    MessageQueueError,
    QueueItemUpdateRequest,
    QueueOrderRequest,
    SessionQueueState,
)
from agent_server.deps import current_user_id, get_message_queue_service
from agent_server.services.session_message_queue import MessageQueueService

router = APIRouter(prefix="/sessions", tags=["session-queue"])


def _raise(exc: MessageQueueError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail()) from exc


@router.get("/{session_id}/runtime/queue", response_model=SessionQueueState)
async def read_queue(
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
) -> SessionQueueState:
    try:
        queue = await service.read(session_id, user_id=user_id)
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueState.model_validate(queue)


@router.delete("/{session_id}/runtime/queue", response_model=SessionQueueState)
async def clear_queue(
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
) -> SessionQueueState:
    try:
        queue = await service.clear(session_id, user_id=user_id)
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueState.model_validate(queue)


@router.post("/{session_id}/runtime/queue/resume", response_model=SessionQueueState)
async def resume_queue(
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
) -> SessionQueueState:
    try:
        queue = await service.resume(session_id, user_id=user_id)
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueState.model_validate(queue)


@router.put("/{session_id}/runtime/queue/order", response_model=SessionQueueState)
async def reorder_queue(
    session_id: str,
    payload: QueueOrderRequest,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
) -> SessionQueueState:
    try:
        queue = await service.reorder(session_id, payload.messageIds, user_id=user_id)
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueState.model_validate(queue)


@router.delete("/{session_id}/runtime/queue/{message_id}", response_model=SessionQueueState)
async def delete_queue_item(
    session_id: str,
    message_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
) -> SessionQueueState:
    try:
        queue = await service.delete(session_id, message_id, user_id=user_id)
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueState.model_validate(queue)


@router.post("/{session_id}/runtime/queue/{message_id}/retry", response_model=SessionQueueState)
async def retry_queue_item(
    session_id: str,
    message_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
) -> SessionQueueState:
    try:
        queue = await service.retry(session_id, message_id, user_id=user_id)
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueState.model_validate(queue)


@router.post("/{session_id}/runtime/queue/{message_id}/send-now", response_model=SessionQueueState)
async def send_queue_item_now(
    session_id: str,
    message_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
) -> SessionQueueState:
    try:
        queue = await service.send_now(session_id, message_id, user_id=user_id)
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueState.model_validate(queue)


@router.patch("/{session_id}/runtime/queue/{message_id}", response_model=SessionQueueState)
async def update_queue_item(
    session_id: str,
    message_id: str,
    payload: QueueItemUpdateRequest,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
) -> SessionQueueState:
    try:
        queue = await service.update(
            session_id,
            message_id,
            user_id=user_id,
            content=payload.content,
            attachment_ids=(
                [item.fileId for item in payload.attachments]
                if payload.attachments is not None
                else None
            ),
        )
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueState.model_validate(queue)
