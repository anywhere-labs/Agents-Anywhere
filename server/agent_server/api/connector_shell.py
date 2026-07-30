from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from agent_server.api.connector_common import (
    connector_scope_id,
    raise_connector_service_error,
    require_owned_connector,
    require_owned_online_connector,
)
from agent_server.core.models import (
    RpcResponsePayload,
    ShellExecRequest,
    ShellTaskStartResponse,
    ShellTaskWaitResponse,
)
from agent_server.core.utc import utc_now
from agent_server.deps import (
    current_user_id,
    get_connector_shell_service,
    get_rpc,
    get_store,
)
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.repositories.facade import Store
from agent_server.services.connector_rpc import ConnectorServiceError
from agent_server.services.connector_shell import (
    ConnectorShellService,
    ConnectorShellTaskNotFoundError,
    ConnectorShellTaskTimeoutError,
)
from agent_server.services.workspace import resolve_workspace_path

router = APIRouter(prefix="/connectors", tags=["connector-shell"])


@router.post("/{connector_id}/shell/exec", response_model=RpcResponsePayload)
async def connector_shell_exec(
    connector_id: str,
    payload: ShellExecRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    shell: ConnectorShellService = Depends(get_connector_shell_service),
) -> RpcResponsePayload:
    await require_owned_online_connector(connector_id, user_id, store, manager)
    cwd = resolve_workspace_path(root, payload.cwd or ".")
    try:
        result = await shell.exec(
            connector_id=connector_id,
            scope_id=connector_scope_id(connector_id),
            root=root,
            cwd=cwd,
            command=payload.command,
            timeout_ms=payload.timeoutMs,
        )
    except ConnectorServiceError as exc:
        raise_connector_service_error(exc)
    return RpcResponsePayload(ok=True, result=result)


@router.post("/{connector_id}/shell/tasks", response_model=ShellTaskStartResponse)
async def connector_shell_task_start(
    connector_id: str,
    payload: ShellExecRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    shell: ConnectorShellService = Depends(get_connector_shell_service),
) -> ShellTaskStartResponse:
    await require_owned_online_connector(connector_id, user_id, store, manager)
    cwd = resolve_workspace_path(root, payload.cwd or ".")
    scope_id = connector_scope_id(connector_id)
    try:
        task = await shell.start(
            connector_id=connector_id,
            scope_id=scope_id,
            root=root,
            cwd=cwd,
            command=payload.command,
            timeout_ms=payload.timeoutMs,
        )
    except ConnectorServiceError as exc:
        raise_connector_service_error(exc)
    return ShellTaskStartResponse(**task.view(), serverTime=utc_now())


@router.get(
    "/{connector_id}/shell/tasks/{task_id}/wait",
    response_model=ShellTaskWaitResponse,
)
async def connector_shell_task_wait(
    connector_id: str,
    task_id: str,
    timeoutMs: int = Query(default=120_000, ge=1, le=300_000),
    user_id: str = Depends(current_user_id),
    store: Store = Depends(get_store),
    shell: ConnectorShellService = Depends(get_connector_shell_service),
) -> ShellTaskWaitResponse:
    await require_owned_connector(connector_id, user_id, store)
    try:
        completed = await shell.wait(
            scope_id=connector_scope_id(connector_id),
            task_id=task_id,
            timeout_seconds=timeoutMs / 1000,
        )
    except ConnectorShellTaskNotFoundError:
        raise HTTPException(status_code=404, detail="shell task not found") from None
    except ConnectorShellTaskTimeoutError:
        raise HTTPException(
            status_code=408,
            detail="shell task wait timed out",
        ) from None
    return ShellTaskWaitResponse(**completed.view(), serverTime=utc_now())
