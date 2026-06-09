from __future__ import annotations

import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query
from loguru import logger

from agent_server.infra.connector_rpc import ConnectorOfflineError, ConnectorRpcError, ConnectorRpcManager
from agent_server.deps import current_user_id, get_rpc, get_shell_tasks, get_store
from agent_server.core.models import (
    RpcResponsePayload,
    ShellExecRequest,
    ShellTaskStartResponse,
    ShellTaskWaitResponse,
)
from agent_server.services.workspace import (
    local_rpc_session,
    request_connector,
    resolve_workspace_path,
)
from agent_server.services.shell_tasks import ShellTaskManager
from agent_server.infra.repositories.facade import Store
from agent_server.core.utc import utc_now


router = APIRouter(prefix="/sessions", tags=["sessions-shell"])


@router.post("/{session_id}/shell/exec", response_model=RpcResponsePayload)
async def shell_exec(
    session_id: str,
    payload: ShellExecRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    session = await local_rpc_session(session_id, user_id, db, manager)
    cwd = resolve_workspace_path(session.cwd, payload.cwd or ".")
    timeout = min((payload.timeoutMs / 1000) + 5, 310)
    result = await request_connector(
        manager,
        session.connectorId,
        "shell.exec",
        {
            "sessionId": session.id,
            "root": session.cwd,
            "cwd": cwd,
            "command": payload.command,
            "timeoutMs": payload.timeoutMs,
        },
        timeout=timeout,
    )
    return RpcResponsePayload(ok=True, result=result)


@router.post("/{session_id}/shell/tasks", response_model=ShellTaskStartResponse)
async def shell_task_start(
    session_id: str,
    payload: ShellExecRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    tasks: ShellTaskManager = Depends(get_shell_tasks),
) -> ShellTaskStartResponse:
    session = await local_rpc_session(session_id, user_id, db, manager)
    cwd = resolve_workspace_path(session.cwd, payload.cwd or ".")
    task = tasks.create(
        session_id=session.id,
        connector_id=session.connectorId,
        command=payload.command,
        cwd=cwd,
        timeout_ms=payload.timeoutMs,
    )
    try:
        await request_connector(
            manager,
            session.connectorId,
            "shell.task.start",
            {
                "taskId": task.id,
                "sessionId": session.id,
                "root": session.cwd,
                "cwd": cwd,
                "command": payload.command,
                "timeoutMs": payload.timeoutMs,
            },
            timeout=10,
        )
    except HTTPException:
        tasks.abandon(task.id, session_id=session.id)
        raise
    task.status = "running"
    return ShellTaskStartResponse(**task.view(), serverTime=utc_now())


@router.get("/{session_id}/shell/tasks/{task_id}/wait", response_model=ShellTaskWaitResponse)
async def shell_task_wait(
    session_id: str,
    task_id: str,
    timeoutMs: int = Query(default=120_000, ge=1, le=300_000),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    tasks: ShellTaskManager = Depends(get_shell_tasks),
) -> ShellTaskWaitResponse:
    try:
        session = await db.get_session(session_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="session not found") from None
    try:
        task = tasks.get(task_id, session_id=session.id)
    except KeyError:
        raise HTTPException(status_code=404, detail="shell task not found") from None
    try:
        await asyncio.wait_for(task.event.wait(), timeout=timeoutMs / 1000)
    except TimeoutError:
        await _abandon_shell_task(session.id, task.id, task.connector_id, manager, tasks)
        raise HTTPException(status_code=408, detail="shell task wait timed out") from None
    except asyncio.CancelledError:
        await _abandon_shell_task(session.id, task.id, task.connector_id, manager, tasks)
        raise
    completed = tasks.pop(task.id, session_id=session.id)
    return ShellTaskWaitResponse(**completed.view(), serverTime=utc_now())


async def _abandon_shell_task(
    session_id: str,
    task_id: str,
    connector_id: str,
    manager: ConnectorRpcManager,
    tasks: ShellTaskManager,
) -> None:
    task = tasks.abandon(task_id, session_id=session_id)
    if task is None:
        return
    try:
        await manager.request(
            connector_id,
            "shell.task.cancel",
            {"taskId": task_id, "sessionId": session_id},
            timeout=5,
        )
    except (ConnectorOfflineError, ConnectorRpcError, TimeoutError):
        logger.warning(
            "failed to cancel abandoned shell task task_id={} session_id={}", task_id, session_id
        )
