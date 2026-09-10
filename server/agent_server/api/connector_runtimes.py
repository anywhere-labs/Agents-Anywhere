from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import ValidationError

from agent_server.core.device_runtime import (
    DeviceRuntimeListResponse,
    DeviceRuntimeView,
    RuntimeActivePutRequest,
    RuntimeConfigPutRequest,
    RuntimeInstanceCreateRequest,
    RuntimeInstancePatchRequest,
    RuntimeTypeListResponse,
)
from agent_server.core.models import (
    RuntimeCommandListResponse,
    RuntimeCommandView,
)
from agent_server.core.protocol import (
    ProtocolCapabilitiesResponse,
    ProtocolCapabilitySet,
    ProtocolModelCatalog,
    ProtocolModelCatalogResponse,
    ProtocolPermissionCatalog,
    ProtocolPermissionCatalogResponse,
)
from agent_server.core.utc import utc_now
from agent_server.deps import current_user_id, get_device_runtime_service, get_rpc
from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)
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


@router.get(
    "/{connector_id}/runtime-types",
    response_model=RuntimeTypeListResponse,
)
async def list_connector_runtime_types(
    connector_id: str,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    user_id: str = Depends(current_user_id),
) -> RuntimeTypeListResponse:
    try:
        runtime_types = await service.list_runtime_types(
            connector_id,
            user_id=user_id,
        )
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)
    return RuntimeTypeListResponse(
        connectorId=connector_id,
        runtimeTypes=runtime_types,
        serverTime=utc_now(),
    )


@router.post(
    "/{connector_id}/runtime-types/discover",
    response_model=RuntimeTypeListResponse,
)
async def discover_connector_runtime_types(
    connector_id: str,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    user_id: str = Depends(current_user_id),
) -> RuntimeTypeListResponse:
    try:
        runtime_types = await service.discover_runtime_types(
            connector_id,
            user_id=user_id,
        )
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)
    return RuntimeTypeListResponse(
        connectorId=connector_id,
        runtimeTypes=runtime_types,
        serverTime=utc_now(),
    )


@router.post(
    "/{connector_id}/runtimes",
    response_model=DeviceRuntimeView,
    status_code=201,
)
async def create_connector_runtime(
    connector_id: str,
    payload: RuntimeInstanceCreateRequest,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    user_id: str = Depends(current_user_id),
) -> DeviceRuntimeView:
    try:
        return await service.create_runtime(
            connector_id,
            runtime_type=payload.runtimeType,
            name=payload.name,
            config=payload.config,
            active=payload.active,
            user_id=user_id,
        )
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)


@router.get(
    "/{connector_id}/runtimes/{runtime_id}",
    response_model=DeviceRuntimeView,
)
async def get_connector_runtime(
    connector_id: str,
    runtime_id: str,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    user_id: str = Depends(current_user_id),
) -> DeviceRuntimeView:
    try:
        return await service.get_runtime(
            connector_id,
            runtime_id,
            user_id=user_id,
        )
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)


@router.patch(
    "/{connector_id}/runtimes/{runtime_id}",
    response_model=DeviceRuntimeView,
)
async def patch_connector_runtime(
    connector_id: str,
    runtime_id: str,
    payload: RuntimeInstancePatchRequest,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    user_id: str = Depends(current_user_id),
) -> DeviceRuntimeView:
    try:
        return await service.rename_runtime(
            connector_id,
            runtime_id,
            payload.name,
            user_id=user_id,
        )
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)


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


@router.get(
    "/{connector_id}/runtimes/{runtime_id}/capabilities",
    response_model=ProtocolCapabilitiesResponse,
)
async def get_connector_runtime_capabilities(
    connector_id: str,
    runtime_id: str,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    manager: ConnectorRpcManager = Depends(get_rpc),
    user_id: str = Depends(current_user_id),
) -> ProtocolCapabilitiesResponse:
    try:
        runtime = await service.ensure_active_running(
            connector_id, runtime_id, user_id=user_id
        )
        result = await request_runtime_rpc(
            manager,
            connector_id,
            "runtime.capabilities",
            runtime=runtime.runtimeType,
            runtime_id=runtime.runtimeId,
            limit=None,
        )
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)
    capability_set = parse_runtime_capability_response(result)
    return ProtocolCapabilitiesResponse(
        connectorId=connector_id,
        capabilitySet=capability_set,
        serverTime=utc_now(),
    )


@router.get(
    "/{connector_id}/runtimes/{runtime_id}/catalogs/model",
    response_model=ProtocolModelCatalogResponse,
)
async def get_connector_runtime_model_catalog(
    connector_id: str,
    runtime_id: str,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    manager: ConnectorRpcManager = Depends(get_rpc),
    user_id: str = Depends(current_user_id),
) -> ProtocolModelCatalogResponse:
    try:
        runtime = await service.ensure_active_running(
            connector_id, runtime_id, user_id=user_id
        )
        result = await request_runtime_rpc(
            manager,
            connector_id,
            "runtime.modelCatalog",
            runtime=runtime.runtimeType,
            runtime_id=runtime.runtimeId,
            limit=200,
        )
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)
    return ProtocolModelCatalogResponse(
        catalog=parse_runtime_model_catalog_response(result),
        serverTime=utc_now(),
    )


@router.get(
    "/{connector_id}/runtimes/{runtime_id}/catalogs/permission",
    response_model=ProtocolPermissionCatalogResponse,
)
async def get_connector_runtime_permission_catalog(
    connector_id: str,
    runtime_id: str,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    manager: ConnectorRpcManager = Depends(get_rpc),
    user_id: str = Depends(current_user_id),
) -> ProtocolPermissionCatalogResponse:
    try:
        runtime = await service.ensure_active_running(
            connector_id, runtime_id, user_id=user_id
        )
        result = await request_runtime_rpc(
            manager,
            connector_id,
            "runtime.permissionCatalog",
            runtime=runtime.runtimeType,
            runtime_id=runtime.runtimeId,
            limit=200,
        )
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)
    return ProtocolPermissionCatalogResponse(
        catalog=parse_runtime_permission_catalog_response(result),
        serverTime=utc_now(),
    )


@router.get(
    "/{connector_id}/runtimes/{runtime_id}/commands",
    response_model=RuntimeCommandListResponse,
)
async def get_connector_runtime_commands(
    connector_id: str,
    runtime_id: str,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    manager: ConnectorRpcManager = Depends(get_rpc),
    user_id: str = Depends(current_user_id),
) -> RuntimeCommandListResponse:
    try:
        runtime = await service.ensure_active_running(
            connector_id, runtime_id, user_id=user_id
        )
        result = await request_runtime_rpc(
            manager,
            connector_id,
            "runtime.commands",
            runtime=runtime.runtimeType,
            runtime_id=runtime.runtimeId,
            limit=100,
        )
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)
    commands = parse_runtime_commands_response(result)
    return RuntimeCommandListResponse(commands=commands, serverTime=utc_now())


def _raise_device_runtime_error(exc: DeviceRuntimeError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


async def request_runtime_rpc(
    manager: ConnectorRpcManager,
    connector_id: str,
    method: str,
    *,
    runtime: str,
    runtime_id: str,
    limit: int | None,
) -> Any:
    params: dict[str, Any] = {"runtime": runtime, "runtimeId": runtime_id}
    if limit is not None:
        params["limit"] = limit
    try:
        return await manager.request(connector_id, method, params, timeout=30)
    except ConnectorOfflineError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ConnectorRpcError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": exc.code, "message": exc.message or exc.code},
        ) from exc


def parse_runtime_capability_response(result: Any) -> ProtocolCapabilitySet:
    raw_capability_set = result.get("capabilitySet") if isinstance(result, dict) else None
    if not isinstance(raw_capability_set, dict):
        raise_invalid_runtime_response("invalid_runtime_capabilities")
    try:
        return ProtocolCapabilitySet.model_validate(raw_capability_set)
    except ValidationError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "invalid_runtime_capabilities", "message": str(exc)},
        ) from exc


def parse_runtime_model_catalog_response(result: Any) -> ProtocolModelCatalog:
    raw_catalog = result.get("catalog") if isinstance(result, dict) else None
    if not isinstance(raw_catalog, dict):
        raise_invalid_runtime_response("invalid_runtime_catalog")
    try:
        return ProtocolModelCatalog.model_validate(raw_catalog)
    except ValidationError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "invalid_runtime_catalog", "message": str(exc)},
        ) from exc


def parse_runtime_permission_catalog_response(result: Any) -> ProtocolPermissionCatalog:
    raw_catalog = result.get("catalog") if isinstance(result, dict) else None
    if not isinstance(raw_catalog, dict):
        raise_invalid_runtime_response("invalid_runtime_catalog")
    try:
        return ProtocolPermissionCatalog.model_validate(raw_catalog)
    except ValidationError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "invalid_runtime_catalog", "message": str(exc)},
        ) from exc


def parse_runtime_commands_response(result: Any) -> list[RuntimeCommandView]:
    commands = result.get("commands") if isinstance(result, dict) else None
    if not isinstance(commands, list):
        raise_invalid_runtime_response("invalid_runtime_commands")
    try:
        return [RuntimeCommandView.model_validate(command) for command in commands]
    except ValidationError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "invalid_runtime_commands", "message": str(exc)},
        ) from exc


def raise_invalid_runtime_response(code: str) -> None:
    raise HTTPException(
        status_code=502,
        detail={
            "code": code,
            "message": "connector returned an invalid runtime response",
        },
    )
