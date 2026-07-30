from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from agent_server.core.device_runtime import (
    DeviceRuntimeListResponse,
    DeviceRuntimeView,
    RuntimeActivePutRequest,
    RuntimeConfigPutRequest,
)
from agent_server.core.utc import utc_now
from agent_server.deps import current_user_id, get_device_runtime_service
from agent_server.services.device_runtimes import (
    DeviceRuntimeError,
    DeviceRuntimeService,
)

router = APIRouter(prefix="/connectors", tags=["connector-runtimes"])


@router.get(
    "/{connector_id}/runtimes",
    response_model=DeviceRuntimeListResponse,
)
async def list_connector_runtimes(
    connector_id: str,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    user_id: str = Depends(current_user_id),
) -> DeviceRuntimeListResponse:
    try:
        runtimes = await service.list_runtimes(connector_id, user_id=user_id)
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)
    return DeviceRuntimeListResponse(
        connectorId=connector_id,
        runtimes=runtimes,
        serverTime=utc_now(),
    )


@router.post(
    "/{connector_id}/runtimes/discover",
    response_model=DeviceRuntimeListResponse,
)
async def discover_connector_runtimes(
    connector_id: str,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    user_id: str = Depends(current_user_id),
) -> DeviceRuntimeListResponse:
    try:
        runtimes = await service.discover(connector_id, user_id=user_id)
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)
    return DeviceRuntimeListResponse(
        connectorId=connector_id,
        runtimes=runtimes,
        serverTime=utc_now(),
    )


@router.put(
    "/{connector_id}/runtimes/{runtime_id}/config",
    response_model=DeviceRuntimeView,
)
async def put_connector_runtime_config(
    connector_id: str,
    runtime_id: str,
    payload: RuntimeConfigPutRequest,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    user_id: str = Depends(current_user_id),
) -> DeviceRuntimeView:
    try:
        return await service.put_config(
            connector_id,
            runtime_id,
            payload.config,
            user_id=user_id,
        )
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)


@router.put(
    "/{connector_id}/runtimes/{runtime_id}/active",
    response_model=DeviceRuntimeView,
)
async def put_connector_runtime_active(
    connector_id: str,
    runtime_id: str,
    payload: RuntimeActivePutRequest,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    user_id: str = Depends(current_user_id),
) -> DeviceRuntimeView:
    try:
        return await service.set_active(
            connector_id,
            runtime_id,
            payload.active,
            user_id=user_id,
        )
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)


@router.delete(
    "/{connector_id}/runtimes/{runtime_id}/config",
    response_model=DeviceRuntimeView,
)
async def delete_connector_runtime_config(
    connector_id: str,
    runtime_id: str,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    user_id: str = Depends(current_user_id),
) -> DeviceRuntimeView:
    try:
        return await service.delete_config(
            connector_id,
            runtime_id,
            user_id=user_id,
        )
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)


def _raise_device_runtime_error(exc: DeviceRuntimeError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
