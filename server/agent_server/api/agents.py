from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from agent_server.deps import current_user_id, get_store
from agent_server.core.models import RuntimeName
from agent_server.core.protocol import (
    ProtocolModelCatalog,
    ProtocolModelCatalogResponse,
    ProtocolPermissionCatalog,
    ProtocolPermissionCatalogResponse,
)
from agent_server.infra.repositories.facade import Store
from agent_server.core.utc import utc_now


router = APIRouter(prefix="/agents", tags=["agents"])


@router.get("/{runtime}/model-catalog", response_model=ProtocolModelCatalogResponse)
async def get_agent_model_catalog(
    runtime: RuntimeName,
    connector_id: str = Query(alias="connectorId", min_length=1),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> ProtocolModelCatalogResponse:
    try:
        raw = await db.get_protocol_catalog(
            connector_id,
            runtime=runtime,
            catalog_type="model",
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    return ProtocolModelCatalogResponse(
        catalog=ProtocolModelCatalog.model_validate(raw)
        if raw is not None
        else ProtocolModelCatalog(runtime=runtime, revision=0, models=[]),
        serverTime=utc_now(),
    )


@router.get("/{runtime}/permission-catalog", response_model=ProtocolPermissionCatalogResponse)
async def get_agent_permission_catalog(
    runtime: RuntimeName,
    connector_id: str = Query(alias="connectorId", min_length=1),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> ProtocolPermissionCatalogResponse:
    try:
        raw = await db.get_protocol_catalog(
            connector_id,
            runtime=runtime,
            catalog_type="permission",
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    return ProtocolPermissionCatalogResponse(
        catalog=ProtocolPermissionCatalog.model_validate(raw)
        if raw is not None
        else ProtocolPermissionCatalog(runtime=runtime, revision=0, permissions=[]),
        serverTime=utc_now(),
    )
