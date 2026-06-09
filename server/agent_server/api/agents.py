from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from agent_server.deps import current_user_id, get_runtime_config_service, get_store
from agent_server.core.models import AgentCatalogResponse, RuntimeName
from agent_server.core.runtime_config import RuntimeConfigSchemaResponse
from agent_server.services.runtime_config import RuntimeConfigService
from agent_server.infra.repositories.facade import Store
from agent_server.core.utc import utc_now


router = APIRouter(prefix="/agents", tags=["agents"])


@router.get("/{runtime}/modes", response_model=AgentCatalogResponse)
async def list_agent_modes(
    runtime: RuntimeName,
    _user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> AgentCatalogResponse:
    return AgentCatalogResponse(
        runtime=runtime,
        entries=await db.list_agent_modes(runtime),
        serverTime=utc_now(),
    )


@router.get("/{runtime}/models", response_model=AgentCatalogResponse)
async def list_agent_models(
    runtime: RuntimeName,
    _user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> AgentCatalogResponse:
    return AgentCatalogResponse(
        runtime=runtime,
        entries=await db.list_agent_models(runtime),
        serverTime=utc_now(),
    )


@router.get("/{runtime}/efforts", response_model=AgentCatalogResponse)
async def list_agent_efforts(
    runtime: RuntimeName,
    _user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> AgentCatalogResponse:
    return AgentCatalogResponse(
        runtime=runtime,
        entries=await db.list_agent_efforts(runtime),
        serverTime=utc_now(),
    )


@router.get("/{runtime}/config-schema", response_model=RuntimeConfigSchemaResponse)
async def get_runtime_config_schema(
    runtime: RuntimeName,
    _user_id: str = Depends(current_user_id),
    runtime_config: RuntimeConfigService = Depends(get_runtime_config_service),
) -> RuntimeConfigSchemaResponse:
    try:
        schema = await runtime_config.get_runtime_config_schema(runtime)
    except KeyError:
        raise HTTPException(status_code=500, detail=f"runtime config schema missing: {runtime}") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return RuntimeConfigSchemaResponse(
        runtime=runtime,
        configSchema=schema,
        serverTime=utc_now(),
    )
