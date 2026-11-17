from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import ValidationError

from agent_server.api.client_forward import call as client_call
from agent_server.api.client_forward import forward_connector, owned_device, to_response
from agent_server.api.v2_compat import V3_CONNECTOR_ONLY
from agent_server.core.device_runtime import (
    DeviceRuntimeListResponse,
    DeviceRuntimeView,
    RuntimeActivePutRequest,
    RuntimeConfigPutRequest,
    RuntimeInstanceCreateRequest,
    RuntimeInstancePatchRequest,
    RuntimeTypeListResponse,
    public_runtime_view,
)
from agent_server.core.e2ee_settings import E2eeSettings
from agent_server.core.models import (
    RuntimeCommandListResponse,
)
from agent_server.core.protocol import (
    ProtocolCapabilitiesResponse,
    ProtocolCapabilitySet,
    ProtocolModelCatalogResponse,
    ProtocolPermissionCatalogResponse,
)
from agent_server.core.utc import utc_now
from agent_server.deps import (
    current_user_id,
    get_device_runtime_service,
    get_e2ee_settings,
    get_model_channel_service,
)
from agent_server.services.device_runtimes import (
    DeviceRuntimeError,
    DeviceRuntimeService,
)
from agent_server.services.model_channels import ModelChannelService

# Runtime instance management of a v2 Connector needs Agents Anywhere upgraded on that device (D4).
router = APIRouter(prefix="/connectors", tags=["connector-runtimes"], dependencies=V3_CONNECTOR_ONLY)






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
        runtimes=[public_runtime_view(runtime) for runtime in runtimes],
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
        runtimes=[public_runtime_view(runtime) for runtime in runtimes],
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
        return public_runtime_view(await service.create_runtime(
            connector_id,
            runtime_type=payload.runtimeType,
            name=payload.name,
            config=payload.config,
            active=payload.active,
            user_id=user_id,
        ))
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
        return public_runtime_view(await service.get_runtime(
            connector_id,
            runtime_id,
            user_id=user_id,
        ))
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
        return public_runtime_view(await service.rename_runtime(
            connector_id,
            runtime_id,
            payload.name,
            user_id=user_id,
        ))
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
        return public_runtime_view(await service.put_config(
            connector_id,
            runtime_id,
            payload.config,
            user_id=user_id,
        ))
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
        return public_runtime_view(await service.set_active(
            connector_id,
            runtime_id,
            payload.active,
            user_id=user_id,
        ))
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)


@router.delete(
    "/{connector_id}/runtimes/{runtime_id}/config",
    response_model=DeviceRuntimeView,
    summary="Delete a runtime and return its final, unconfigured state",
)
async def delete_connector_runtime_config(
    connector_id: str,
    runtime_id: str,
    service: DeviceRuntimeService = Depends(get_device_runtime_service),
    user_id: str = Depends(current_user_id),
) -> DeviceRuntimeView:
    try:
        return public_runtime_view(await service.delete_config(
            connector_id,
            runtime_id,
            user_id=user_id,
        ))
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
    user_id: str = Depends(current_user_id),
    e2ee: E2eeSettings = Depends(get_e2ee_settings),
) -> ProtocolCapabilitiesResponse:
    """The capability set the device reported with the instance (device-meshcall has no capability read)."""

    try:
        runtime = await service.ensure_active_running(
            connector_id, runtime_id, user_id=user_id
        )
        reported = await service.runtime_capabilities(connector_id, runtime.runtimeId)
    except DeviceRuntimeError as exc:
        _raise_device_runtime_error(exc)
    if e2ee.required:
        reported = without_plaintext_workflows(reported)
    try:
        capability_set = ProtocolCapabilitySet.model_validate(reported)
    except ValidationError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "invalid_runtime_capabilities", "message": str(exc)},
        ) from exc
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
    request: Request,
    connector_id: str,
    runtime_id: str,
    user_id: str = Depends(current_user_id),
    channels: ModelChannelService = Depends(get_model_channel_service),
) -> Any:
    await owned_device(request, user_id=user_id, connector_id=connector_id)

    async def _channel_overlay(body: Any) -> Any:
        parsed = ProtocolModelCatalogResponse.model_validate(body)
        catalog = await channels.channel_catalog(connector_id, runtime_id, parsed.catalog, user_id=user_id)
        return ProtocolModelCatalogResponse(catalog=catalog, serverTime=utc_now()).model_dump(mode="json")

    return to_response(await client_call(
        request, "connector.runtime.catalogs.model", user_id=user_id, device_id=connector_id,
        response_model=ProtocolModelCatalogResponse, decorate=_channel_overlay,
    ))


@router.get(
    "/{connector_id}/runtimes/{runtime_id}/catalogs/permission",
    response_model=ProtocolPermissionCatalogResponse,
)
async def get_connector_runtime_permission_catalog(
    request: Request,
    connector_id: str,
    runtime_id: str,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.runtime.catalogs.permission", user_id=user_id, connector_id=connector_id,
        response_model=ProtocolPermissionCatalogResponse,
    )


@router.get(
    "/{connector_id}/runtimes/{runtime_id}/commands",
    response_model=RuntimeCommandListResponse,
)
async def get_connector_runtime_commands(
    request: Request,
    connector_id: str,
    runtime_id: str,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.runtime.commands", user_id=user_id, connector_id=connector_id,
        response_model=RuntimeCommandListResponse,
    )


def _raise_device_runtime_error(exc: DeviceRuntimeError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


# Runtime workflows carry first messages, answers and paths, so required mode refuses them (``e2ee_settings``); a
# client that saw them declared would prepare a workspace and fail instead of creating the session directly.
PLAINTEXT_WORKFLOW_CAPABILITIES = frozenset({"runtime.workspace.prepare", "runtime.session.async_create"})


def without_plaintext_workflows(capability_set: dict[str, Any]) -> dict[str, Any]:
    items = capability_set.get("capabilities")
    if not isinstance(items, list):
        return capability_set
    kept = [
        item for item in items
        if not (isinstance(item, dict) and item.get("capabilityId") in PLAINTEXT_WORKFLOW_CAPABILITIES)
    ]
    return {**capability_set, "capabilities": kept}
