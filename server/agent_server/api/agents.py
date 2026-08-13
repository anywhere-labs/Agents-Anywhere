from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException

from agent_server.core.protocol import (
    ProtocolModelCatalogResponse,
    ProtocolPermissionCatalogResponse,
)
from agent_server.core.runtime_identity import RuntimeId
from agent_server.deps import current_user_id

router = APIRouter(prefix="/agents", tags=["agents"])


def removed_agent_catalog_detail(runtime: RuntimeId, catalog: str) -> dict[str, str]:
    return {
        "code": "agent_catalog_route_removed",
        "message": "Agent catalog query routes were removed from the v2 target API.",
        "use": f"/connectors/{{connectorId}}/runtimes/{runtime}/catalogs/{catalog}",
    }


@router.get(
    "/{runtime}/model-catalog",
    response_model=ProtocolModelCatalogResponse,
    include_in_schema=False,
)
async def get_agent_model_catalog(
    runtime: RuntimeId,
    user_id: str = Depends(current_user_id),
) -> ProtocolModelCatalogResponse:
    """Reject the removed agent catalog route.

    Side effects:
    - authenticates the caller through the standard dependency;
    - does not start runtimes or perform connector RPC.
    """

    if not user_id:
        raise HTTPException(status_code=401, detail="unauthorized")
    raise HTTPException(
        status_code=410,
        detail=removed_agent_catalog_detail(runtime, "model"),
    )


@router.get(
    "/{runtime}/permission-catalog",
    response_model=ProtocolPermissionCatalogResponse,
    include_in_schema=False,
)
async def get_agent_permission_catalog(
    runtime: RuntimeId,
    user_id: str = Depends(current_user_id),
) -> ProtocolPermissionCatalogResponse:
    """Reject the removed agent catalog route.

    Side effects:
    - authenticates the caller through the standard dependency;
    - does not start runtimes or perform connector RPC.
    """

    if not user_id:
        raise HTTPException(status_code=401, detail="unauthorized")
    raise HTTPException(
        status_code=410,
        detail=removed_agent_catalog_detail(runtime, "permission"),
    )
