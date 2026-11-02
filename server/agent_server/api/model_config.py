from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, Response

from agent_server.core.model_config import (
    ApplyRequest,
    ManualProfileRequest,
    PreviewRequest,
    ProfilePatchRequest,
)
from agent_server.deps import current_user_id, get_model_config_service
from agent_server.services.device_runtimes import DeviceRuntimeError
from agent_server.services.model_config import ModelConfigError, ModelConfigService

router = APIRouter(tags=["model-config"])


def _raise(exc: ModelConfigError | DeviceRuntimeError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _etag(value: str | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value.strip().strip('"'))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="If-Match must be a profile etag") from exc


def _idempotency_key(value: str | None) -> str:
    if not value or len(value) > 200:
        raise HTTPException(status_code=400, detail="Idempotency-Key header is required")
    return value


@router.get("/model-profiles")
async def list_model_profiles(
    service: Annotated[ModelConfigService, Depends(get_model_config_service)],
    user_id: Annotated[str, Depends(current_user_id)],
) -> dict[str, Any]:
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


@router.get("/model-config/assignments")
async def list_assignments(
    service: Annotated[ModelConfigService, Depends(get_model_config_service)],
    user_id: Annotated[str, Depends(current_user_id)],
) -> dict[str, Any]:
    overview = await service.overview(user_id=user_id)
    return {"assignments": overview["assignments"]}


@router.post("/model-config/assignments/preview")
async def preview_assignments(
    payload: PreviewRequest,
    service: Annotated[ModelConfigService, Depends(get_model_config_service)],
    user_id: Annotated[str, Depends(current_user_id)],
) -> dict[str, Any]:
    try:
        return await service.preview(payload, user_id=user_id)
    except (ModelConfigError, DeviceRuntimeError) as exc:
        _raise(exc)


@router.post("/model-config/assignments")
async def apply_assignments(
    payload: ApplyRequest,
    service: Annotated[ModelConfigService, Depends(get_model_config_service)],
    user_id: Annotated[str, Depends(current_user_id)],
    idempotency_key: Annotated[str | None, Header()] = None,
) -> dict[str, Any]:
    try:
        return await service.apply(
            payload, user_id=user_id, idempotency_key=_idempotency_key(idempotency_key)
        )
    except (ModelConfigError, DeviceRuntimeError) as exc:
        _raise(exc)


@router.delete("/model-config/assignments/{connector_id}/{runtime_id}")
async def restore_assignment(
    connector_id: str,
    runtime_id: str,
    service: Annotated[ModelConfigService, Depends(get_model_config_service)],
    user_id: Annotated[str, Depends(current_user_id)],
    allow_interrupt: bool = False,
) -> dict[str, Any]:
    try:
        return await service.restore(
            connector_id, runtime_id, user_id=user_id, allow_interrupt=allow_interrupt
        )
    except (ModelConfigError, DeviceRuntimeError) as exc:
        _raise(exc)


@router.get("/model-config/operations/{operation_id}")
async def get_operation(
    operation_id: str,
    service: Annotated[ModelConfigService, Depends(get_model_config_service)],
    user_id: Annotated[str, Depends(current_user_id)],
) -> dict[str, Any]:
    try:
        return await service.get_operation(operation_id, user_id=user_id)
    except ModelConfigError as exc:
        _raise(exc)
