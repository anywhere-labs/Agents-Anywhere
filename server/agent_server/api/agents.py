from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import ValidationError

from agent_server.core.models import RuntimeName
from agent_server.core.protocol import (
    ProtocolModelCatalog,
    ProtocolModelCatalogResponse,
    ProtocolPermissionCatalog,
    ProtocolPermissionCatalogResponse,
)
from agent_server.core.utc import utc_now
from agent_server.deps import current_user_id, get_rpc, get_store
from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)
from agent_server.infra.repositories.facade import Store

router = APIRouter(prefix="/agents", tags=["agents"])


@router.get("/{runtime}/model-catalog", response_model=ProtocolModelCatalogResponse)
async def get_agent_model_catalog(
    runtime: RuntimeName,
    connector_id: str = Query(alias="connectorId", min_length=1),
    query: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=100, ge=1, le=200),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> ProtocolModelCatalogResponse:
    await _require_connector_owner(db, connector_id, user_id)
    result = await _runtime_catalog_request(
        manager,
        connector_id,
        "runtime.modelCatalog",
        runtime=runtime,
        query=query,
        limit=limit,
    )
    catalog = _protocol_catalog(result, "model")
    return ProtocolModelCatalogResponse(
        catalog=catalog,
        serverTime=utc_now(),
    )


@router.get("/{runtime}/permission-catalog", response_model=ProtocolPermissionCatalogResponse)
async def get_agent_permission_catalog(
    runtime: RuntimeName,
    connector_id: str = Query(alias="connectorId", min_length=1),
    query: str | None = Query(default=None, max_length=128),
    limit: int = Query(default=100, ge=1, le=200),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> ProtocolPermissionCatalogResponse:
    await _require_connector_owner(db, connector_id, user_id)
    result = await _runtime_catalog_request(
        manager,
        connector_id,
        "runtime.permissionCatalog",
        runtime=runtime,
        query=query,
        limit=limit,
    )
    catalog = _protocol_catalog(result, "permission")
    return ProtocolPermissionCatalogResponse(
        catalog=catalog,
        serverTime=utc_now(),
    )


async def _require_connector_owner(
    db: Store,
    connector_id: str,
    user_id: str,
) -> None:
    try:
        connector = await db.get_connector(connector_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    if connector.userId != user_id:
        raise HTTPException(status_code=404, detail="connector not found")


async def _runtime_catalog_request(
    manager: ConnectorRpcManager,
    connector_id: str,
    method: str,
    *,
    runtime: RuntimeName,
    query: str | None,
    limit: int,
) -> Any:
    params: dict[str, Any] = {"runtime": runtime, "limit": limit}
    if query:
        params["query"] = query
    try:
        return await manager.request(connector_id, method, params, timeout=30)
    except ConnectorOfflineError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ConnectorRpcError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": exc.code, "message": exc.message or exc.code},
        ) from exc


def _protocol_catalog(
    result: Any,
    catalog_type: str,
) -> ProtocolModelCatalog | ProtocolPermissionCatalog:
    raw = result.get("catalog") if isinstance(result, dict) else None
    if not isinstance(raw, dict):
        raise HTTPException(
            status_code=502,
            detail={
                "code": "invalid_runtime_catalog",
                "message": "connector did not return a catalog",
            },
        )
    model = ProtocolModelCatalog if catalog_type == "model" else ProtocolPermissionCatalog
    try:
        return model.model_validate(raw)
    except ValidationError as exc:
        raise HTTPException(
            status_code=502,
            detail={"code": "invalid_runtime_catalog", "message": str(exc)},
        ) from exc
