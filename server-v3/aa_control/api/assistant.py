from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import StreamingResponse

from aa_control.api.deps import (
    current_own_session_user,
    current_user,
    get_assistant_service,
)
from aa_control.core.models import (
    AssistantConversationDetail,
    AssistantConversationMeta,
    AssistantEncryptionStatusResponse,
    AssistantTokensView,
    DeleteAssistantTokensResponse,
    ListAssistantConversationsResponse,
    OkResponse,
    PutAssistantConversationRequest,
    PutAssistantKeyEnvelopeRequest,
    PutAssistantTokensRequest,
    ResetAssistantEncryptionRequest,
    ResetAssistantEncryptionResponse,
    UserView,
)
from aa_control.services.assistant_service import AssistantService

router = APIRouter(prefix="/assistant", tags=["assistant"])

_NO_STORE_HEADERS = {"Cache-Control": "no-store", "Pragma": "no-cache"}


# ---------------------------------------------------------------------------
# 1. Whole-conversation sync
# ---------------------------------------------------------------------------


@router.get("/conversations", response_model=ListAssistantConversationsResponse)
async def list_assistant_conversations(
    user: Annotated[UserView, Depends(current_user)],
    assistant: Annotated[AssistantService, Depends(get_assistant_service)],
) -> ListAssistantConversationsResponse:
    return await assistant.list_conversations(user.id)


@router.get("/conversations/{conversation_id}", response_model=AssistantConversationDetail)
async def get_assistant_conversation(
    conversation_id: str,
    user: Annotated[UserView, Depends(current_user)],
    assistant: Annotated[AssistantService, Depends(get_assistant_service)],
) -> AssistantConversationDetail:
    return await assistant.get_conversation(user_id=user.id, conversation_id=conversation_id)


@router.put("/conversations/{conversation_id}", response_model=AssistantConversationMeta)
async def put_assistant_conversation(
    conversation_id: str,
    payload: PutAssistantConversationRequest,
    user: Annotated[UserView, Depends(current_user)],
    assistant: Annotated[AssistantService, Depends(get_assistant_service)],
) -> AssistantConversationMeta:
    return await assistant.put_conversation(
        user_id=user.id,
        conversation_id=conversation_id,
        req=payload,
    )


@router.delete("/conversations/{conversation_id}", response_model=OkResponse)
async def delete_assistant_conversation(
    conversation_id: str,
    user: Annotated[UserView, Depends(current_user)],
    assistant: Annotated[AssistantService, Depends(get_assistant_service)],
    device: Annotated[str, Query(max_length=64)] = "",
) -> OkResponse:
    await assistant.delete_conversation(
        user_id=user.id,
        conversation_id=conversation_id,
        device=device,
    )
    return OkResponse(ok=True)


# ---------------------------------------------------------------------------
# 2. Cross-device real-time event stream (SSE backed by Redis Pub/Sub)
# ---------------------------------------------------------------------------


@router.get("/events")
async def stream_assistant_events(
    request: Request,
    user: Annotated[UserView, Depends(current_user)],
    assistant: Annotated[AssistantService, Depends(get_assistant_service)],
) -> StreamingResponse:
    heartbeat = assistant.sse_heartbeat_seconds
    poll_timeout = min(1.0, max(0.05, heartbeat))

    async def event_stream() -> AsyncIterator[str]:
        async with assistant.open_events(user.id) as sub:
            yield ": connected\n\n"
            last_activity = time.monotonic()
            while True:
                if await request.is_disconnected():
                    break
                ev = await sub.next_event(timeout=poll_timeout)
                if ev is not None:
                    data = json.dumps(ev.payload, ensure_ascii=False, separators=(",", ":"))
                    yield f"event: {ev.event}\ndata: {data}\n\n"
                    last_activity = time.monotonic()
                elif time.monotonic() - last_activity >= heartbeat:
                    yield ": heartbeat\n\n"
                    last_activity = time.monotonic()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ---------------------------------------------------------------------------
# 3. Account-level KEK/DEK key envelope (any-password multi-device E2EE)
# ---------------------------------------------------------------------------


@router.get("/encryption", response_model=AssistantEncryptionStatusResponse)
async def get_assistant_encryption(
    user: Annotated[UserView, Depends(current_user)],
    assistant: Annotated[AssistantService, Depends(get_assistant_service)],
) -> AssistantEncryptionStatusResponse:
    return await assistant.get_encryption_status(user.id)


@router.put("/encryption", response_model=AssistantEncryptionStatusResponse)
async def put_assistant_encryption(
    payload: PutAssistantKeyEnvelopeRequest,
    user: Annotated[UserView, Depends(current_user)],
    assistant: Annotated[AssistantService, Depends(get_assistant_service)],
) -> AssistantEncryptionStatusResponse:
    return await assistant.put_key_envelope(user_id=user.id, req=payload)


@router.post("/encryption/reset", response_model=ResetAssistantEncryptionResponse)
async def reset_assistant_encryption(
    payload: ResetAssistantEncryptionRequest,
    user: Annotated[UserView, Depends(current_user)],
    assistant: Annotated[AssistantService, Depends(get_assistant_service)],
) -> ResetAssistantEncryptionResponse:
    return await assistant.reset_encryption(user_id=user.id, req=payload)


@router.delete("/encryption", response_model=ResetAssistantEncryptionResponse)
async def delete_assistant_encryption(
    user: Annotated[UserView, Depends(current_user)],
    assistant: Annotated[AssistantService, Depends(get_assistant_service)],
    confirm_wipe: Annotated[bool, Query()] = False,
    wipe_drive_vfs: Annotated[bool, Query()] = True,
    device: Annotated[str, Query(max_length=64)] = "",
) -> ResetAssistantEncryptionResponse:
    return await assistant.delete_encryption(
        user_id=user.id,
        confirm_wipe=confirm_wipe,
        wipe_drive_vfs=wipe_drive_vfs,
        device=device,
    )


# ---------------------------------------------------------------------------
# 4. Tokens Anywhere managed key reuse & auto-refresh (own-session only)
# ---------------------------------------------------------------------------


@router.get("/tokens", response_model=AssistantTokensView)
async def get_assistant_tokens(
    response: Response,
    user: Annotated[UserView, Depends(current_own_session_user)],
    assistant: Annotated[AssistantService, Depends(get_assistant_service)],
) -> AssistantTokensView:
    for k, v in _NO_STORE_HEADERS.items():
        response.headers[k] = v
    return await assistant.get_tokens(user.id)


@router.put("/tokens", response_model=AssistantTokensView)
async def put_assistant_tokens(
    payload: PutAssistantTokensRequest,
    response: Response,
    user: Annotated[UserView, Depends(current_own_session_user)],
    assistant: Annotated[AssistantService, Depends(get_assistant_service)],
) -> AssistantTokensView:
    for k, v in _NO_STORE_HEADERS.items():
        response.headers[k] = v
    return await assistant.put_tokens(user_id=user.id, req=payload)


@router.delete("/tokens", response_model=DeleteAssistantTokensResponse)
async def delete_assistant_tokens(
    response: Response,
    user: Annotated[UserView, Depends(current_own_session_user)],
    assistant: Annotated[AssistantService, Depends(get_assistant_service)],
    key_hash: Annotated[str | None, Query(max_length=128)] = None,
) -> DeleteAssistantTokensResponse:
    for k, v in _NO_STORE_HEADERS.items():
        response.headers[k] = v
    return await assistant.delete_tokens(user_id=user.id, expected_key_hash=key_hash)
