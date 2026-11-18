"""Device shell (``/connectors/{id}/shell/*``): ``exec`` and background tasks, answered by the device with
``Client/call``.

A task runs on the device; ``wait`` holds the call until the task ends (its output and exit code) or ``timeoutMs``
passes, which kills the task and answers 408 ``shell_task_wait_timeout``. A task is taken by the first ``wait`` that
sees it end. v2 Connectors answer 409 ``device_upgrade_required``.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query, Request

from agent_server.api.client_forward import forward_connector
from agent_server.core.client_routes import MAX_HOLD_MS
from agent_server.core.models import (
    RpcResponsePayload,
    ShellExecRequest,
    ShellTaskCancelResponse,
    ShellTaskStartResponse,
    ShellTaskWaitResponse,
)
from agent_server.deps import current_user_id

router = APIRouter(prefix="/connectors", tags=["connector-shell"])


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
    return await forward_connector(
        request, "connector.shell.tasks.start", user_id=user_id, connector_id=connector_id,
        response_model=ShellTaskStartResponse,
    )


@router.get(
    "/{connector_id}/shell/tasks/{task_id}/wait",
    response_model=ShellTaskWaitResponse,
)
async def connector_shell_task_wait(
    request: Request,
    connector_id: str,
    task_id: str,
    timeoutMs: int = Query(default=120_000, ge=1, le=MAX_HOLD_MS),
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.shell.tasks.wait", user_id=user_id, connector_id=connector_id,
        response_model=ShellTaskWaitResponse, query={"timeoutMs": str(timeoutMs)},
    )


@router.post("/{connector_id}/shell/tasks/{task_id}/cancel", response_model=ShellTaskCancelResponse)
async def connector_shell_task_cancel(
    request: Request,
    connector_id: str,
    task_id: str,
    user_id: str = Depends(current_user_id),
) -> Any:
    return await forward_connector(
        request, "connector.shell.tasks.cancel", user_id=user_id, connector_id=connector_id,
        response_model=ShellTaskCancelResponse,
    )
