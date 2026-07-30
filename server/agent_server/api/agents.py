from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from agent_server.core.models import RuntimeName
from agent_server.core.protocol import (
    ProtocolModelCatalog,
    ProtocolModelCatalogResponse,
    ProtocolPermissionCatalog,
    ProtocolPermissionCatalogResponse,
)
from agent_server.core.utc import utc_now
from agent_server.deps import current_user_id, get_catalog_service
from agent_server.services.catalogs import CatalogService

router = APIRouter(prefix="/agents", tags=["agents"])


@router.get("/{runtime}/model-catalog", response_model=ProtocolModelCatalogResponse)
async def get_agent_model_catalog(
    runtime: RuntimeName,
    connector_id: str = Query(alias="connectorId", min_length=1),
    user_id: str = Depends(current_user_id),
    catalogs: CatalogService = Depends(get_catalog_service),
) -> ProtocolModelCatalogResponse:
    try:
        catalog = await catalogs.model_catalog(
            connector_id,
            runtime=runtime,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    return ProtocolModelCatalogResponse(
        catalog=catalog or ProtocolModelCatalog(runtime=runtime, revision=0, models=[]),
        serverTime=utc_now(),
    )


@router.get("/{runtime}/permission-catalog", response_model=ProtocolPermissionCatalogResponse)
async def get_agent_permission_catalog(
    runtime: RuntimeName,
    connector_id: str = Query(alias="connectorId", min_length=1),
    user_id: str = Depends(current_user_id),
    catalogs: CatalogService = Depends(get_catalog_service),
) -> ProtocolPermissionCatalogResponse:
    try:
        catalog = await catalogs.permission_catalog(
            connector_id,
            runtime=runtime,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    return ProtocolPermissionCatalogResponse(
        catalog=catalog or ProtocolPermissionCatalog(runtime=runtime, revision=0, permissions=[]),
        serverTime=utc_now(),
    )
