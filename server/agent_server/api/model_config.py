from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Response

from agent_server.core.model_channel import (
    ChannelRequest,
    RetryRequest,
    RuntimeChannelRequest,
)
from agent_server.core.model_config import ManualProfileRequest, ProfilePatchRequest
from agent_server.deps import (
    current_user_id,
    get_model_channel_service,
    get_model_config_service,
    get_tokens_link_service,
)
from agent_server.services.device_runtimes import DeviceRuntimeError
from agent_server.services.model_channels import ModelChannelService
from agent_server.services.model_config import ModelConfigError, ModelConfigService
from agent_server.services.tokens_link import TokensLinkService

router = APIRouter(tags=["model-config"])
Channels = Annotated[ModelChannelService, Depends(get_model_channel_service)]
UserId = Annotated[str, Depends(current_user_id)]


def _raise(exc: ModelConfigError | DeviceRuntimeError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _etag(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value.strip().strip('"'))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="If-Match must be a profile etag") from exc


@router.get("/model-profiles")
async def list_model_profiles(
    service: Annotated[TokensLinkService, Depends(get_tokens_link_service)],
    user_id: Annotated[str, Depends(current_user_id)],
) -> dict[str, Any]:
    # The same shape as the snapshot's ``modelConfig``.
    return await service.overview(user_id=user_id)


@router.post("/model-profiles", status_code=201)
async def create_model_profile(
    payload: ManualProfileRequest,
    service: Annotated[ModelConfigService, Depends(get_model_config_service)],
    user_id: Annotated[str, Depends(current_user_id)],
) -> dict[str, Any]:
    try:
        return await service.create_manual_profile(payload, user_id=user_id)
    except ModelConfigError as exc:
        _raise(exc)


@router.patch("/model-profiles/{profile_id}")
async def update_model_profile(
    profile_id: str,
    payload: ProfilePatchRequest,
    service: Annotated[ModelConfigService, Depends(get_model_config_service)],
    user_id: Annotated[str, Depends(current_user_id)],
    if_match: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    try:
        return await service.update_profile(
            profile_id, payload, user_id=user_id, expected_etag=_etag(if_match)
        )
    except ModelConfigError as exc:
        _raise(exc)


@router.delete("/model-profiles/{profile_id}", status_code=204)
async def delete_model_profile(
    profile_id: str,
    service: Annotated[ModelConfigService, Depends(get_model_config_service)],
    user_id: Annotated[str, Depends(current_user_id)],
) -> Response:
    try:
        await service.delete_profile(profile_id, user_id=user_id)
    except ModelConfigError as exc:
        _raise(exc)
    return Response(status_code=204)


@router.get("/model-config/channel")
async def get_model_channel(channels: Channels, user_id: UserId) -> dict[str, Any]:
    # Looking at the channel is also a chance for waiting switches to go on.
    await channels.kick(user_id=user_id)
    return await channels.state(user_id=user_id)


@router.put("/model-config/channel")
async def put_model_channel(payload: ChannelRequest, channels: Channels, user_id: UserId) -> dict[str, Any]:
    try:
        return await channels.set_channel(payload.channel, user_id=user_id)
    except (ModelConfigError, DeviceRuntimeError) as exc:
        _raise(exc)


@router.put("/model-config/channel/runtimes/{connector_id}/{runtime_id}")
async def put_runtime_channel(
    connector_id: str, runtime_id: str, payload: RuntimeChannelRequest, channels: Channels, user_id: UserId,
) -> dict[str, Any]:
    try:
        return await channels.set_runtime_channel(
            connector_id, runtime_id, payload.channel,
            user_id=user_id, confirm_native_global=payload.confirmNativeGlobal,
        )
    except (ModelConfigError, DeviceRuntimeError) as exc:
        _raise(exc)


@router.post("/model-config/channel/retry")
async def retry_model_channel(
    channels: Channels, user_id: UserId, payload: RetryRequest | None = None,
) -> dict[str, Any]:
    target = payload or RetryRequest()
    if (target.connectorId is None) != (target.runtimeId is None):
        raise HTTPException(status_code=422, detail="connectorId and runtimeId go together")
    return await channels.retry(user_id=user_id, connector_id=target.connectorId, runtime_id=target.runtimeId)
