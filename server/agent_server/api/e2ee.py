"""``/api/v3/e2ee``: plaintext side channels of the E2EE ``required`` mode.

Only command registrations live here (contracts/e2ee/1.0 ``CommandRegistration``); the commands themselves and
every content read travel through the secure channel (``WS /api/v3/tunnel``).
"""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from agent_server.core.e2ee import CommandRegistration
from agent_server.deps import current_user_id, get_e2ee_command_service
from agent_server.services.e2ee_commands import E2eeCommandError, E2eeCommandService

router = APIRouter(prefix="/e2ee", tags=["e2ee"])


class CommandRegistrationView(BaseModel):
    commandId: str
    deviceId: str
    inputDigest: str
    registeredAt: str
    outcome: Literal["accepted", "rejected"] | None = None
    errorCode: str | None = None
    finishedAt: str | None = None
    #: True when this ``commandId`` was already registered with the same input: the client is retrying and
    #: must not send the command through the channel a second time unless it has no outcome yet and the
    #: device's own log says it never arrived.
    duplicate: bool = False


def _raise(exc: E2eeCommandError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail()) from exc


@router.post("/commands", response_model=CommandRegistrationView)
async def register_command(
    payload: CommandRegistration,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[E2eeCommandService, Depends(get_e2ee_command_service)],
) -> CommandRegistrationView:
    try:
        view = await service.register(user_id, payload)
    except E2eeCommandError as exc:
        _raise(exc)
    return CommandRegistrationView.model_validate(view)


@router.get("/commands/{command_id}", response_model=CommandRegistrationView)
async def command_status(
    command_id: str,
    user_id: Annotated[str, Depends(current_user_id)],
    service: Annotated[E2eeCommandService, Depends(get_e2ee_command_service)],
) -> CommandRegistrationView:
    try:
        view = await service.status(user_id, command_id)
    except E2eeCommandError as exc:
        _raise(exc)
    return CommandRegistrationView.model_validate(view)
