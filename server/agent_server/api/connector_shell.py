"""Device shell (``/connectors/{id}/shell/*``). ``exec`` goes to the device with ``Client/call``.

Shell tasks reported their completion with a v2 notification that has no carrier on v3: they answer 409
``shell_tasks_unsupported``, and v2 Connectors 409 ``device_upgrade_required``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from agent_server.api.client_forward import forward_connector, owned_device
from agent_server.core.models import (
    RpcResponsePayload,
    ShellExecRequest,
    ShellTaskStartResponse,
    ShellTaskWaitResponse,
)
from agent_server.deps import current_user_id

router = APIRouter(prefix="/connectors", tags=["connector-shell"])

SHELL_TASKS_UNSUPPORTED = {
    "code": "shell_tasks_unsupported",
    "message": "Shell tasks are not available on this device; use shell/exec.",
}


@router.post("/{connector_id}/shell/exec", response_model=RpcResponsePayload)
async def connector_shell_exec(
    request: Request,
    connector_id: str,
    payload: ShellExecRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.shell.exec", user_id=user_id, connector_id=connector_id, response_model=RpcResponsePayload
    )


@router.post("/{connector_id}/shell/tasks", response_model=ShellTaskStartResponse)
async def connector_shell_task_start(
    request: Request,
    connector_id: str,
    payload: ShellExecRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
) -> Any:
    await owned_device(request, user_id=user_id, connector_id=connector_id)
    raise HTTPException(status_code=409, detail=SHELL_TASKS_UNSUPPORTED)


@router.get(
    "/{connector_id}/shell/tasks/{task_id}/wait",
    response_model=ShellTaskWaitResponse,
)
async def connector_shell_task_wait(
    request: Request,
    connector_id: str,
    task_id: str,
    timeoutMs: int = Query(default=120_000, ge=1, le=300_000),
    user_id: str = Depends(current_user_id),
) -> Any:
    await owned_device(request, user_id=user_id, connector_id=connector_id)
    raise HTTPException(status_code=409, detail=SHELL_TASKS_UNSUPPORTED)
