"""REST surface of the server-owned session message queue.

Messages enter the queue through ``POST /sessions/{id}/runtime/messages`` with
``queue: "auto" | "interrupt"``; these routes read and change what waits.
Fixed paths (``resume``, ``order``) are declared before ``{message_id}``.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from starlette.requests import HTTPConnection

from agent_server.api.device_session_reads import device_read_http_error
from agent_server.api.v2_compat import V3_SESSION_ONLY
from agent_server.core.message_queue import (
    MessageQueueError,
    QueueItemUpdateRequest,
    QueueOrderRequest,
    SessionQueueState,
)
from agent_server.core.protocol_v1_2 import SessionQueueStateV12
from agent_server.deps import (
    current_user_id,
    get_device_reads,
    get_message_queue_service,
    get_store,
)
from agent_server.infra.repositories.facade import Store
from agent_server.services.device_queue import DeviceQueueError, DeviceQueueService
from agent_server.services.device_reads import (
    DeviceReadError,
    DeviceReadService,
    DeviceReadTimeout,
)
from agent_server.services.session_message_queue import MessageQueueService

router = APIRouter(prefix="/sessions", tags=["session-queue"])


def _raise(exc: MessageQueueError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail()) from exc


def get_device_queue(conn: HTTPConnection) -> DeviceQueueService:
    return conn.app.state.device_queue


class _DeviceQueueRoute:
    """For sessions on v3 devices the queue is the device's; ``None`` means a v2 session."""

    def __init__(
        self,
        db: Annotated[Store, Depends(get_store)],
        reads: Annotated[DeviceReadService, Depends(get_device_reads)],
        queue: Annotated[DeviceQueueService, Depends(get_device_queue)],
    ) -> None:
        self.db, self.reads, self.queue = db, reads, queue

    async def device_id(self, session_id: str, user_id: str) -> str | None:
        try:
            session = await self.db.get_session(session_id, user_id=user_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="session not found") from None
        return session.connectorId if await self.reads.is_v3_device(session.connectorId) else None

    async def read(self, session_id: str, user_id: str) -> SessionQueueState | None:
        device_id = await self.device_id(session_id, user_id)
        if device_id is None:
            return None
        try:
            return SessionQueueStateV12.model_validate(await self.queue.read(device_id, session_id))
        except (DeviceReadTimeout, DeviceReadError) as exc:
            raise device_read_http_error(exc) from exc

    async def change(self, session_id: str, user_id: str, kind: str, payload: dict[str, Any]) -> SessionQueueState | None:
        device_id = await self.device_id(session_id, user_id)
        if device_id is None:
            return None
        try:
            state = await self.queue.change(
                user_id=user_id, device_id=device_id, session_id=session_id, kind=kind, payload=payload
            )
            return SessionQueueState.model_validate(state)
        except DeviceQueueError as exc:
            raise HTTPException(status_code=exc.status, detail={"code": exc.code, "message": exc.message}) from exc
        except (DeviceReadTimeout, DeviceReadError) as exc:
            raise device_read_http_error(exc) from exc


DeviceQueue = Annotated[_DeviceQueueRoute, Depends()]


@router.get("/{session_id}/runtime/queue", response_model=SessionQueueStateV12, dependencies=V3_SESSION_ONLY)
async def read_queue(
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
    device_queue: DeviceQueue,
) -> SessionQueueState:
    if (device := await device_queue.read(session_id, user_id)) is not None:
        return device
    try:
        queue = await service.read(session_id, user_id=user_id)
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueStateV12.model_validate(queue)


@router.delete("/{session_id}/runtime/queue", response_model=SessionQueueState, dependencies=V3_SESSION_ONLY)
async def clear_queue(
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
    device_queue: DeviceQueue,
) -> SessionQueueState:
    if (device := await device_queue.change(session_id, user_id, "clear", {})) is not None:
        return device
    try:
        queue = await service.clear(session_id, user_id=user_id)
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueState.model_validate(queue)


@router.post("/{session_id}/runtime/queue/resume", response_model=SessionQueueState, dependencies=V3_SESSION_ONLY)
async def resume_queue(
    session_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
    device_queue: DeviceQueue,
) -> SessionQueueState:
    if (device := await device_queue.change(session_id, user_id, "resume", {})) is not None:
        return device
    try:
        queue = await service.resume(session_id, user_id=user_id)
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueState.model_validate(queue)


@router.put("/{session_id}/runtime/queue/order", response_model=SessionQueueState, dependencies=V3_SESSION_ONLY)
async def reorder_queue(
    session_id: str,
    payload: QueueOrderRequest,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
    device_queue: DeviceQueue,
) -> SessionQueueState:
    if (device := await device_queue.change(session_id, user_id, "reorder", {"messageIds": payload.messageIds})) is not None:
        return device
    try:
        queue = await service.reorder(session_id, payload.messageIds, user_id=user_id)
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueState.model_validate(queue)


@router.delete("/{session_id}/runtime/queue/{message_id}", response_model=SessionQueueState, dependencies=V3_SESSION_ONLY)
async def delete_queue_item(
    session_id: str,
    message_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
    device_queue: DeviceQueue,
) -> SessionQueueState:
    if (device := await device_queue.change(session_id, user_id, "delete", {"messageId": message_id})) is not None:
        return device
    try:
        queue = await service.delete(session_id, message_id, user_id=user_id)
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueState.model_validate(queue)


@router.post("/{session_id}/runtime/queue/{message_id}/retry", response_model=SessionQueueState, dependencies=V3_SESSION_ONLY)
async def retry_queue_item(
    session_id: str,
    message_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
    device_queue: DeviceQueue,
) -> SessionQueueState:
    if (device := await device_queue.change(session_id, user_id, "retry", {"messageId": message_id})) is not None:
        return device
    try:
        queue = await service.retry(session_id, message_id, user_id=user_id)
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueState.model_validate(queue)


@router.post("/{session_id}/runtime/queue/{message_id}/send-now", response_model=SessionQueueState, dependencies=V3_SESSION_ONLY)
async def send_queue_item_now(
    session_id: str,
    message_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
    device_queue: DeviceQueue,
) -> SessionQueueState:
    if (device := await device_queue.change(session_id, user_id, "sendNow", {"messageId": message_id})) is not None:
        return device
    try:
        queue = await service.send_now(session_id, message_id, user_id=user_id)
    except MessageQueueError as exc:
        _raise(exc)
    return SessionQueueState.model_validate(queue)


@router.patch("/{session_id}/runtime/queue/{message_id}", response_model=SessionQueueState, dependencies=V3_SESSION_ONLY)
async def update_queue_item(
    session_id: str,
    message_id: str,
    payload: QueueItemUpdateRequest,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[MessageQueueService, Depends(get_message_queue_service)],
    device_queue: DeviceQueue,
) -> SessionQueueState:
    if (device := await device_queue.change(session_id, user_id, "update", payload.model_dump(exclude_none=True) | {"messageId": message_id})) is not None:
        return device
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
