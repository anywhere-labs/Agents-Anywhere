from __future__ import annotations

from copy import deepcopy
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
from agent_server.core.runtime_config import RuntimeConfigOption, RuntimeConfigSchemaResponse
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


@router.get("/{runtime}/models", response_model=AgentCatalogResponse)
async def list_agent_models(
    runtime: RuntimeName,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> AgentCatalogResponse:
    defaults = await db.get_user_agent_defaults(user_id)
    runtime_defaults = defaults.get(runtime)
    if runtime_defaults and runtime_defaults.get("models"):
        return AgentCatalogResponse(
            runtime=runtime,
            entries=runtime_defaults["models"],
            serverTime=utc_now(),
        )
    return AgentCatalogResponse(
        runtime=runtime,
        entries=await db.list_agent_models(runtime),
        serverTime=utc_now(),
    )


@router.get("/{runtime}/efforts", response_model=AgentCatalogResponse)
async def list_agent_efforts(
    runtime: RuntimeName,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> AgentCatalogResponse:
    defaults = await db.get_user_agent_defaults(user_id)
    runtime_defaults = defaults.get(runtime)
    if runtime_defaults and runtime_defaults.get("efforts"):
        return AgentCatalogResponse(
            runtime=runtime,
            entries=runtime_defaults["efforts"],
            serverTime=utc_now(),
        )
    return AgentCatalogResponse(
        runtime=runtime,
        entries=await db.list_agent_efforts(runtime),
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
        schema = _schema_with_user_catalog(schema, defaults.get(runtime))
    except KeyError:
        raise HTTPException(status_code=500, detail=f"runtime config schema missing: {runtime}") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return RuntimeConfigSchemaResponse(
        runtime=runtime,
        configSchema=schema,
        serverTime=utc_now(),
    )


def _agent_defaults_response(raw: dict[str, Any]) -> dict[str, UserAgentDefaultRuntime]:
    return {
        runtime: UserAgentDefaultRuntime(
            runtime=item["runtime"],
            enabled=item["enabled"],
            settings=item["settings"],
            models=item["models"],
            efforts=item["efforts"],
        )
        for runtime, item in raw.items()
    }


def _schema_with_user_catalog(schema: Any, defaults: dict[str, Any] | None) -> Any:
    if not defaults:
        return schema
    result = deepcopy(schema)
    catalogs: dict[str, list[AgentCatalogEntry]] = {
        "model": defaults.get("models") or [],
        "effort": defaults.get("efforts") or [],
    }
    for field in result.fields:
        entries = catalogs.get(field.key)
        if not entries:
            continue
        field.options = [
            RuntimeConfigOption(
                value=entry.key,
                label=entry.displayLabel,
                description=entry.description,
            )
            for entry in entries
        ]
    return result
