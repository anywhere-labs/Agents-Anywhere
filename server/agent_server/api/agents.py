from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException

from agent_server.deps import current_user_id, get_runtime_config_service, get_store
from agent_server.core.models import (
    AgentCatalogEntry,
    AgentCatalogResponse,
    RuntimeName,
    UserAgentDefaultsResponse,
    UserAgentDefaultsUpdateRequest,
    UserAgentDefaultRuntime,
)
from agent_server.core.runtime_config import (
    RuntimeConfigSchemaResponse,
    schema_with_user_agent_defaults,
)
from agent_server.core.protocol import ProtocolModelCatalogResponse
from agent_server.services.model_catalog import build_model_catalog
from agent_server.services.runtime_config import RuntimeConfigService
from agent_server.infra.repositories.facade import Store
from agent_server.core.utc import utc_now


router = APIRouter(prefix="/agents", tags=["agents"])


@router.get("/defaults", response_model=UserAgentDefaultsResponse)
async def get_agent_defaults(
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> UserAgentDefaultsResponse:
    return UserAgentDefaultsResponse(
        runtimes=_agent_defaults_response(await db.get_user_agent_defaults(user_id)),
        serverTime=utc_now(),
    )


@router.patch("/defaults", response_model=UserAgentDefaultsResponse)
async def update_agent_defaults(
    payload: UserAgentDefaultsUpdateRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> UserAgentDefaultsResponse:
    try:
        defaults = await db.update_user_agent_defaults(
            user_id,
            {
                runtime: item.model_dump(exclude_none=True)
                for runtime, item in payload.runtimes.items()
            },
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except KeyError:
        raise HTTPException(status_code=404, detail="user not found") from None
    return UserAgentDefaultsResponse(
        runtimes=_agent_defaults_response(defaults),
        serverTime=utc_now(),
    )


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


@router.get("/{runtime}/model-catalog", response_model=ProtocolModelCatalogResponse)
async def get_agent_model_catalog(
    runtime: RuntimeName,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> ProtocolModelCatalogResponse:
    return ProtocolModelCatalogResponse(
        catalog=build_model_catalog(
            runtime=runtime,
            models=await _model_entries_for_user_runtime(db, user_id, runtime),
        ),
        serverTime=utc_now(),
    )


@router.get("/{runtime}/config-schema", response_model=RuntimeConfigSchemaResponse)
async def get_runtime_config_schema(
    runtime: RuntimeName,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    runtime_config: RuntimeConfigService = Depends(get_runtime_config_service),
) -> RuntimeConfigSchemaResponse:
    try:
        schema = await runtime_config.get_runtime_config_schema(runtime)
        defaults = await db.get_user_agent_defaults(user_id)
        schema = schema_with_user_agent_defaults(schema, defaults.get(runtime))
    except KeyError:
        raise HTTPException(status_code=500, detail=f"runtime config schema missing: {runtime}") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return RuntimeConfigSchemaResponse(
        runtime=runtime,
        configSchema=schema,
        serverTime=utc_now(),
    )


async def _model_entries_for_user_runtime(
    db: Store,
    user_id: str,
    runtime: RuntimeName,
) -> list[AgentCatalogEntry]:
    defaults = await db.get_user_agent_defaults(user_id)
    runtime_defaults = defaults.get(runtime)
    if runtime_defaults and runtime_defaults.get("models"):
        return runtime_defaults["models"]
    return await db.list_agent_models(runtime)


def _agent_defaults_response(raw: dict[str, Any]) -> dict[str, UserAgentDefaultRuntime]:
    return {
        runtime: UserAgentDefaultRuntime(
            runtime=item["runtime"],
            enabled=item["enabled"],
            settings=item["settings"],
            models=item["models"],
        )
        for runtime, item in raw.items()
    }
