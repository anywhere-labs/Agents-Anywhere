from __future__ import annotations

import asyncio
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any
import urllib.parse

from fastapi import APIRouter, Body, Depends, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse
from loguru import logger

from agent_server.core.auth import create_signed_token, verify_signed_token, verify_user_access_token
from agent_server.infra.connector_rpc import (
    ConnectorOfflineError,
    ConnectorRpcError,
    ConnectorRpcManager,
)
from agent_server.deps import (
    current_user_id,
    get_device_agent_settings_service,
    get_fs_downloads,
    get_rpc,
    get_shell_tasks,
    get_store,
    get_terminal_service,
    get_timeline_broker,
)
from agent_server.core.models import (
    ArchiveAllRequest,
    ArchiveAllResponse,
    ConnectorCreateRequest,
    ConnectorCreateResponse,
    ConnectorListResponse,
    ConnectorPreferencesResponse,
    ConnectorRevokeResponse,
    ConnectorResponse,
    ConnectorRuntimeCapabilitiesResponse,
    ConnectorRuntimeScanRequest,
    ConnectorRuntimeScanResponse,
    ConnectorUpdateRequest,
    ConnectorView,
    DeviceAgentsState,
    FsPreviewReadRequest,
    FsPreviewReadTextRequest,
    FsPreviewSessionRequest,
    FsPreviewSessionResponse,
    FsPreviewTokenCreateResponse,
    FsReadRequest,
    FsReadTextRequest,
    FsReadTextResponse,
    FsWriteRequest,
    RpcResponsePayload,
    RuntimeName,
    ShellExecRequest,
    ShellTaskStartResponse,
    ShellTaskWaitResponse,
    TerminalCreateRequest,
    TerminalListResponse,
    TerminalPatchRequest,
    TerminalResizeRequest,
    TerminalResponse,
)
from agent_server.core.runtime_config import RuntimeSettingsPatchRequest, RuntimeSettingsResponse
from agent_server.services.runtime_activation import send_active_runtimes
from agent_server.services.connector_presence import with_effective_connector_status, with_effective_session_connector_status
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.device_agent_settings import DeviceAgentSettingsService
from agent_server.services.workspace import request_connector, resolve_workspace_path
from agent_server.services.shell_tasks import ShellTaskManager
from agent_server.services.terminal import (
    TerminalService,
    TerminalServiceError,
    terminal_connector_scope_id,
)
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.infra.repositories.facade import Store, report_is_attachable
from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.core.utc import utc_now


router = APIRouter(prefix="/connectors", tags=["connectors"])
FS_PREVIEW_OPEN_TOKEN_KIND = "fs_preview_open"
FS_PREVIEW_ACCESS_TOKEN_KIND = "fs_preview_access"
FS_PREVIEW_OPEN_EXPIRES_IN = 5 * 60
FS_PREVIEW_ACCESS_EXPIRES_IN = 15 * 60


def _connector_for_response(manager: ConnectorRpcManager, connector: ConnectorView) -> ConnectorView:
    return with_effective_connector_status(manager, connector)


def _raise_terminal_service_error(exc: TerminalServiceError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


async def _send_invalidate_runtime(
    manager: ConnectorRpcManager, connector_id: str, runtime: str
) -> None:
    """Best-effort fire-and-forget invalidate. Used after the user Deletes
    a runtime so the live daemon stops syncing it immediately. Exceptions
    get logged, never bubble back to the HTTP handler that scheduled this
    task — the daemon will reconverge on next discovery push anyway."""
    try:
        await manager.request(
            connector_id,
            "capabilities.invalidateRuntime",
            {"runtime": runtime},
            timeout=15,
        )
    except (ConnectorOfflineError, ConnectorRpcError, TimeoutError) as exc:
        logger.warning(
            "capabilities.invalidateRuntime failed connector_id={} runtime={} error={}",
            connector_id,
            runtime,
            exc,
        )
    except Exception:
        logger.exception(
            "capabilities.invalidateRuntime crashed connector_id={} runtime={}",
            connector_id,
            runtime,
        )


async def _send_force_resync_runtime(
    manager: ConnectorRpcManager, connector_id: str, runtime: str
) -> None:
    """Best-effort fire-and-forget force-resync. Fired after a successful
    Add scan so the daemon ingests the runtime's local sessions / threads
    against a backend that has already committed the attach (no filter
    drops). Generous timeout because codex sync of a long thread list can
    take ~10s; we don't block the HTTP response on it either way."""
    try:
        await manager.request(
            connector_id,
            "capabilities.forceResyncRuntime",
            {"runtime": runtime},
            timeout=90,
        )
    except (ConnectorOfflineError, ConnectorRpcError, TimeoutError) as exc:
        logger.warning(
            "capabilities.forceResyncRuntime failed connector_id={} runtime={} error={}",
            connector_id,
            runtime,
            exc,
        )
    except Exception:
        logger.exception(
            "capabilities.forceResyncRuntime crashed connector_id={} runtime={}",
            connector_id,
            runtime,
        )


@router.get("", response_model=ConnectorListResponse)
async def list_connectors(
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> ConnectorListResponse:
    connectors = await db.list_connectors(user_id=user_id)
    return ConnectorListResponse(
        connectors=[_connector_for_response(manager, connector) for connector in connectors],
        serverTime=utc_now(),
    )


@router.post("", response_model=ConnectorCreateResponse)
async def create_connector(
    payload: ConnectorCreateRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> ConnectorCreateResponse:
    connector, token, prefix = await db.create_connector(name=payload.name, user_id=user_id)
    await publish_dashboard_changed(
        db,
        broker,
        user_id=user_id,
        connector_id=connector.id,
        reason="connector.created",
    )
    return ConnectorCreateResponse(connector=connector, connectorToken=token, tokenPrefix=prefix)


@router.get("/{connector_id}", response_model=ConnectorResponse)
async def get_connector(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> ConnectorResponse:
    try:
        connector = await db.get_connector(connector_id)
        if connector.userId != user_id:
            raise KeyError(connector_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    return ConnectorResponse(connector=_connector_for_response(manager, connector), serverTime=utc_now())


@router.patch("/{connector_id}", response_model=ConnectorResponse)
async def update_connector(
    connector_id: str,
    payload: ConnectorUpdateRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> ConnectorResponse:
    try:
        connector = await db.update_connector(connector_id, owner_user_id=user_id, name=payload.name)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    await publish_dashboard_changed(
        db,
        broker,
        user_id=user_id,
        connector_id=connector_id,
        reason="connector.updated",
    )
    return ConnectorResponse(connector=_connector_for_response(manager, connector), serverTime=utc_now())


@router.delete("/{connector_id}", status_code=204)
async def delete_connector(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> None:
    try:
        await db.revoke_connector(connector_id, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    await manager.disconnect(connector_id, reason="connector deleted")
    await publish_dashboard_changed(
        db,
        broker,
        user_id=user_id,
        connector_id=connector_id,
        reason="connector.deleted",
    )


@router.post("/{connector_id}/revoke", response_model=ConnectorRevokeResponse)
async def revoke_connector_token(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    broker: TimelineBroker = Depends(get_timeline_broker),
) -> ConnectorRevokeResponse:
    try:
        connector, token, prefix = await db.rotate_connector_token(
            connector_id,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    await manager.disconnect(connector_id, reason="connector token revoked")
    await publish_dashboard_changed(
        db,
        broker,
        user_id=user_id,
        connector_id=connector_id,
        reason="connector.revoked",
    )
    return ConnectorRevokeResponse(
        connector=_connector_for_response(manager, connector),
        connectorToken=token,
        tokenPrefix=prefix,
        serverTime=utc_now(),
    )


@router.get("/{connector_id}/preferences", response_model=ConnectorPreferencesResponse)
async def get_connector_preferences(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> ConnectorPreferencesResponse:
    try:
        connector = await db.get_connector(connector_id)
        if connector.userId != user_id:
            raise KeyError(connector_id)
        preferences = await db.get_connector_preferences(connector_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    return ConnectorPreferencesResponse(
        connectorId=connector_id,
        preferences=preferences,
        serverTime=utc_now(),
    )


@router.post("/{connector_id}/fs/list", response_model=RpcResponsePayload)
async def connector_fs_list(
    connector_id: str,
    payload: dict[str, Any] = Body(default_factory=dict),
    root: str | None = Query(default=None, min_length=1),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    connector = await _require_owned_online_connector(connector_id, user_id, db, manager)
    root_value = root or payload.get("root")
    if not isinstance(root_value, str) or not root_value.strip():
        raise HTTPException(status_code=422, detail="root is required")
    raw_path = payload.get("path", ".")
    if not isinstance(raw_path, str):
        raise HTTPException(status_code=422, detail="path must be a string")
    path = "" if connector.deviceOs == "windows" and raw_path == "" else resolve_workspace_path(root_value, raw_path)
    result = await request_connector(
        manager,
        connector_id,
        "fs.readDir",
        {
            "sessionId": _connector_scope_id(connector_id),
            "root": root_value,
            "path": path,
        },
        timeout=30,
    )
    return RpcResponsePayload(ok=True, result=result)


@router.post("/{connector_id}/fs/read", response_model=RpcResponsePayload)
async def connector_fs_read(
    connector_id: str,
    payload: FsReadRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    downloads: FsDownloadRelayManager = Depends(get_fs_downloads),
) -> RpcResponsePayload:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    path = resolve_workspace_path(root, payload.path)
    result = await request_connector(
        manager,
        connector_id,
        "fs.prepareDownload",
        {"sessionId": _connector_scope_id(connector_id), "root": root, "path": path},
        timeout=30,
    )
    if not isinstance(result, dict):
        raise HTTPException(status_code=502, detail="invalid fs.prepareDownload response")
    transfer = downloads.create(
        connector_id=connector_id,
        root=root,
        path=str(result.get("path") or path),
        name=str(result.get("name") or path.rsplit("/", 1)[-1] or "download"),
        size=int(result.get("size") or 0),
        sha256=str(result.get("sha256") or ""),
        media_type=str(result.get("mediaType") or "application/octet-stream"),
    )
    return RpcResponsePayload(
        ok=True,
        result={
            **result,
            "transferId": transfer.transfer_id,
            "token": transfer.token,
            "downloadUrl": f"/connectors/{connector_id}/fs/transfers/{transfer.transfer_id}?token={transfer.token}",
        },
    )


@router.post("/{connector_id}/fs/preview-token", response_model=FsPreviewTokenCreateResponse)
async def create_connector_fs_preview_token(
    connector_id: str,
    payload: FsReadRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
) -> FsPreviewTokenCreateResponse:
    await _require_owned_connector(connector_id, user_id, db)
    path = resolve_workspace_path(root, payload.path)
    expires_at = _utc_now_plus_seconds(FS_PREVIEW_OPEN_EXPIRES_IN)
    preview_token = create_signed_token(
        FS_PREVIEW_OPEN_TOKEN_KIND,
        {
            "user_id": user_id,
            "connector_id": connector_id,
            "root": root,
            "path": path,
        },
        FS_PREVIEW_OPEN_EXPIRES_IN,
    )
    await db.record_fs_preview_token(
        token=preview_token,
        user_id=user_id,
        connector_id=connector_id,
        root=root,
        path=path,
        expires_at=expires_at,
    )
    return FsPreviewTokenCreateResponse(
        previewToken=preview_token,
        expiresAt=expires_at,
        serverTime=utc_now(),
    )


@router.post("/fs/preview-session", response_model=FsPreviewSessionResponse)
async def create_connector_fs_preview_session(
    payload: FsPreviewSessionRequest,
    db: Store = Depends(get_store),
) -> FsPreviewSessionResponse:
    token_payload = verify_signed_token(FS_PREVIEW_OPEN_TOKEN_KIND, payload.previewToken)
    if token_payload is None:
        raise HTTPException(status_code=400, detail="invalid preview token")
    user_id = str(token_payload.get("user_id") or "")
    connector_id = str(token_payload.get("connector_id") or "")
    root = str(token_payload.get("root") or "")
    path = str(token_payload.get("path") or "")
    if not user_id or not connector_id or not root or not path:
        raise HTTPException(status_code=400, detail="invalid preview token")
    consumed = await db.consume_fs_preview_token(
        token=payload.previewToken,
        user_id=user_id,
        connector_id=connector_id,
        root=root,
        path=path,
    )
    if not consumed:
        raise HTTPException(status_code=400, detail="preview token was already used or expired")
    expires_at = _utc_now_plus_seconds(FS_PREVIEW_ACCESS_EXPIRES_IN)
    access_token = create_signed_token(
        FS_PREVIEW_ACCESS_TOKEN_KIND,
        {
            "user_id": user_id,
            "connector_id": connector_id,
            "root": root,
            "path": path,
        },
        FS_PREVIEW_ACCESS_EXPIRES_IN,
    )
    return FsPreviewSessionResponse(
        previewAccessToken=access_token,
        expiresAt=expires_at,
        connectorId=connector_id,
        root=root,
        path=path,
        serverTime=utc_now(),
    )


@router.post("/fs/preview/readText", response_model=FsReadTextResponse)
async def connector_fs_preview_read_text(
    payload: FsPreviewReadTextRequest,
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> FsReadTextResponse:
    preview = _fs_preview_access_payload(payload.previewAccessToken)
    connector_id = preview["connector_id"]
    root = preview["root"]
    path = preview["path"]
    await _require_owned_online_connector(connector_id, preview["user_id"], db, manager)
    result = await request_connector(
        manager,
        connector_id,
        "fs.readText",
        {
            "sessionId": _connector_scope_id(connector_id),
            "root": root,
            "path": path,
            "maxBytes": payload.maxBytes,
        },
        timeout=30,
    )
    return FsReadTextResponse(**result, serverTime=utc_now())


@router.post("/fs/preview/read", response_model=RpcResponsePayload)
async def connector_fs_preview_read(
    payload: FsPreviewReadRequest,
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    downloads: FsDownloadRelayManager = Depends(get_fs_downloads),
) -> RpcResponsePayload:
    preview = _fs_preview_access_payload(payload.previewAccessToken)
    connector_id = preview["connector_id"]
    root = preview["root"]
    path = preview["path"]
    await _require_owned_online_connector(connector_id, preview["user_id"], db, manager)
    result = await request_connector(
        manager,
        connector_id,
        "fs.prepareDownload",
        {"sessionId": _connector_scope_id(connector_id), "root": root, "path": path},
        timeout=30,
    )
    if not isinstance(result, dict):
        raise HTTPException(status_code=502, detail="invalid fs.prepareDownload response")
    transfer = downloads.create(
        connector_id=connector_id,
        root=root,
        path=str(result.get("path") or path),
        name=str(result.get("name") or path.rsplit("/", 1)[-1] or "download"),
        size=int(result.get("size") or 0),
        sha256=str(result.get("sha256") or ""),
        media_type=str(result.get("mediaType") or "application/octet-stream"),
    )
    return RpcResponsePayload(
        ok=True,
        result={
            **result,
            "transferId": transfer.transfer_id,
            "token": transfer.token,
            "downloadUrl": (
                f"/connectors/{connector_id}/fs/transfers/{transfer.transfer_id}"
                f"?token={transfer.token}&previewAccessToken={urllib.parse.quote(payload.previewAccessToken)}"
            ),
        },
    )


@router.get("/{connector_id}/fs/transfers/{transfer_id}")
async def connector_fs_transfer_download(
    connector_id: str,
    transfer_id: str,
    token: str,
    previewAccessToken: str | None = Query(default=None),
    authorization: str | None = Header(None, alias="Authorization"),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    downloads: FsDownloadRelayManager = Depends(get_fs_downloads),
) -> StreamingResponse:
    transfer = downloads.get(transfer_id, token)
    if previewAccessToken:
        preview = _fs_preview_access_payload(previewAccessToken)
        if (
            transfer is None
            or transfer.connector_id != connector_id
            or preview["connector_id"] != connector_id
            or preview["root"] != transfer.root
            or preview["path"] != transfer.path
        ):
            raise HTTPException(status_code=404, detail="transfer not found")
        user_id = preview["user_id"]
    else:
        user_id = _user_id_from_authorization(authorization)
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    if transfer is None or transfer.connector_id != connector_id:
        raise HTTPException(status_code=404, detail="transfer not found")
    await request_connector(
        manager,
        connector_id,
        "fs.uploadPreparedDownload",
        {
            "sessionId": _connector_scope_id(connector_id),
            "transferId": transfer.transfer_id,
            "token": transfer.token,
            "uploadUrl": f"/connector/fs/transfers/{transfer.transfer_id}",
            "root": transfer.root,
            "path": transfer.path,
        },
        timeout=10,
    )
    return StreamingResponse(
        downloads.stream(transfer_id=transfer_id, token=token),
        media_type=transfer.media_type or "application/octet-stream",
        headers={
            "Content-Disposition": f"attachment; filename={_quoted_filename(transfer.name or transfer_id)}",
            "X-File-Name": _safe_header_value(transfer.name or transfer_id),
            "X-File-Sha256": transfer.sha256,
            "X-File-Size": str(transfer.size),
        },
    )


@router.post("/{connector_id}/fs/readText", response_model=FsReadTextResponse)
async def connector_fs_read_text(
    connector_id: str,
    payload: FsReadTextRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> FsReadTextResponse:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    path = resolve_workspace_path(root, payload.path)
    result = await request_connector(
        manager,
        connector_id,
        "fs.readText",
        {
            "sessionId": _connector_scope_id(connector_id),
            "root": root,
            "path": path,
            "maxBytes": payload.maxBytes,
        },
        timeout=30,
    )
    return FsReadTextResponse(**result, serverTime=utc_now())


@router.post("/{connector_id}/fs/write", response_model=RpcResponsePayload)
async def connector_fs_write(
    connector_id: str,
    payload: FsWriteRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    path = resolve_workspace_path(root, payload.path)
    params: dict = {
        "sessionId": _connector_scope_id(connector_id),
        "root": root,
        "path": path,
        "content": payload.content,
        "encoding": payload.encoding,
    }
    if payload.ifMatch is not None:
        params["ifMatch"] = payload.ifMatch
    result = await request_connector(manager, connector_id, "fs.writeFile", params, timeout=30)
    return RpcResponsePayload(ok=True, result=result)


@router.post("/{connector_id}/shell/exec", response_model=RpcResponsePayload)
async def connector_shell_exec(
    connector_id: str,
    payload: ShellExecRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    cwd = resolve_workspace_path(root, payload.cwd or ".")
    timeout = min((payload.timeoutMs / 1000) + 5, 310)
    result = await request_connector(
        manager,
        connector_id,
        "shell.exec",
        {
            "sessionId": _connector_scope_id(connector_id),
            "root": root,
            "cwd": cwd,
            "command": payload.command,
            "timeoutMs": payload.timeoutMs,
        },
        timeout=timeout,
    )
    return RpcResponsePayload(ok=True, result=result)


@router.post("/{connector_id}/shell/tasks", response_model=ShellTaskStartResponse)
async def connector_shell_task_start(
    connector_id: str,
    payload: ShellExecRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    tasks: ShellTaskManager = Depends(get_shell_tasks),
) -> ShellTaskStartResponse:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    cwd = resolve_workspace_path(root, payload.cwd or ".")
    scope_id = _connector_scope_id(connector_id)
    task = tasks.create(
        session_id=scope_id,
        connector_id=connector_id,
        command=payload.command,
        cwd=cwd,
        timeout_ms=payload.timeoutMs,
    )
    try:
        await request_connector(
            manager,
            connector_id,
            "shell.task.start",
            {
                "taskId": task.id,
                "sessionId": scope_id,
                "root": root,
                "cwd": cwd,
                "command": payload.command,
                "timeoutMs": payload.timeoutMs,
            },
            timeout=10,
        )
    except HTTPException:
        tasks.abandon(task.id, session_id=scope_id)
        raise
    task.status = "running"
    return ShellTaskStartResponse(**task.view(), serverTime=utc_now())


@router.get("/{connector_id}/shell/tasks/{task_id}/wait", response_model=ShellTaskWaitResponse)
async def connector_shell_task_wait(
    connector_id: str,
    task_id: str,
    timeoutMs: int = Query(default=120_000, ge=1, le=300_000),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    tasks: ShellTaskManager = Depends(get_shell_tasks),
) -> ShellTaskWaitResponse:
    await _require_owned_connector(connector_id, user_id, db)
    scope_id = _connector_scope_id(connector_id)
    try:
        task = tasks.get(task_id, session_id=scope_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="shell task not found") from None
    try:
        await asyncio.wait_for(task.event.wait(), timeout=timeoutMs / 1000)
    except TimeoutError:
        await _abandon_connector_shell_task(scope_id, task.id, task.connector_id, manager, tasks)
        raise HTTPException(status_code=408, detail="shell task wait timed out") from None
    except asyncio.CancelledError:
        await _abandon_connector_shell_task(scope_id, task.id, task.connector_id, manager, tasks)
        raise
    completed = tasks.pop(task.id, session_id=scope_id)
    return ShellTaskWaitResponse(**completed.view(), serverTime=utc_now())


@router.post("/{connector_id}/terminals", response_model=TerminalResponse)
async def connector_terminal_create(
    connector_id: str,
    payload: TerminalCreateRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    terminal_service: TerminalService = Depends(get_terminal_service),
) -> TerminalResponse:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    try:
        return await terminal_service.create_for_connector(connector_id, root, payload)
    except TerminalServiceError as exc:
        _raise_terminal_service_error(exc)


@router.post("/{connector_id}/terminals-v2", response_model=RpcResponsePayload)
async def connector_terminal_create_v2(
    connector_id: str,
    payload: TerminalCreateRequest,
    root: str = Query(..., min_length=1),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    terminal_id = f"trm_{secrets.token_urlsafe(18)}"
    scope_id = terminal_connector_scope_id(connector_id)
    cwd = resolve_workspace_path(root, payload.cwd or ".")
    result = await request_connector(
        manager,
        connector_id,
        "terminal.create",
        {
            "terminalId": terminal_id,
            "sessionId": scope_id,
            "root": root,
            "cwd": cwd,
            "shell": payload.shell,
            "command": payload.command,
            "args": payload.args or [],
            "profile": payload.profile,
            "cols": payload.cols,
            "rows": payload.rows,
            "env": payload.env or {},
            "label": payload.label,
        },
        timeout=15,
    )
    if isinstance(result, dict):
        result.setdefault("label", payload.label or "Shell")
        result.setdefault("createdAt", utc_now())
    return RpcResponsePayload(ok=True, result=result)


@router.get("/{connector_id}/terminals", response_model=TerminalListResponse)
async def connector_terminal_list(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    terminal_service: TerminalService = Depends(get_terminal_service),
) -> TerminalListResponse:
    await _require_owned_connector(connector_id, user_id, db)
    try:
        return await terminal_service.list_for_connector(connector_id)
    except TerminalServiceError as exc:
        _raise_terminal_service_error(exc)


@router.get("/{connector_id}/terminals-v2", response_model=RpcResponsePayload)
async def connector_terminal_list_v2(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    result = await request_connector(
        manager,
        connector_id,
        "terminal.list",
        {"sessionId": terminal_connector_scope_id(connector_id)},
        timeout=10,
    )
    return RpcResponsePayload(ok=True, result=result)


@router.patch("/{connector_id}/terminals/{terminal_id}", response_model=TerminalResponse)
async def connector_terminal_rename(
    connector_id: str,
    terminal_id: str,
    payload: TerminalPatchRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    terminal_service: TerminalService = Depends(get_terminal_service),
) -> TerminalResponse:
    await _require_owned_connector(connector_id, user_id, db)
    try:
        return await terminal_service.rename_for_connector(connector_id, terminal_id, payload)
    except TerminalServiceError as exc:
        _raise_terminal_service_error(exc)


@router.patch("/{connector_id}/terminals-v2/{terminal_id}", response_model=RpcResponsePayload)
async def connector_terminal_rename_v2(
    connector_id: str,
    terminal_id: str,
    payload: TerminalPatchRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    result = await request_connector(
        manager,
        connector_id,
        "terminal.rename",
        {
            "terminalId": terminal_id,
            "sessionId": terminal_connector_scope_id(connector_id),
            "label": payload.label,
        },
        timeout=10,
    )
    return RpcResponsePayload(ok=True, result=result)


@router.delete("/{connector_id}/terminals/{terminal_id}", response_model=TerminalResponse)
async def connector_terminal_close(
    connector_id: str,
    terminal_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    terminal_service: TerminalService = Depends(get_terminal_service),
) -> TerminalResponse:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    try:
        return await terminal_service.close_for_connector(connector_id, terminal_id)
    except TerminalServiceError as exc:
        _raise_terminal_service_error(exc)


@router.delete("/{connector_id}/terminals-v2/{terminal_id}", response_model=RpcResponsePayload)
async def connector_terminal_close_v2(
    connector_id: str,
    terminal_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    result = await request_connector(
        manager,
        connector_id,
        "terminal.close",
        {"terminalId": terminal_id, "sessionId": terminal_connector_scope_id(connector_id)},
        timeout=10,
    )
    return RpcResponsePayload(ok=True, result=result)


@router.post("/{connector_id}/terminals/{terminal_id}/resize", response_model=TerminalResponse)
async def connector_terminal_resize(
    connector_id: str,
    terminal_id: str,
    payload: TerminalResizeRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    terminal_service: TerminalService = Depends(get_terminal_service),
) -> TerminalResponse:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    try:
        return await terminal_service.resize_for_connector(connector_id, terminal_id, payload)
    except TerminalServiceError as exc:
        _raise_terminal_service_error(exc)


@router.post("/{connector_id}/terminals-v2/{terminal_id}/resize", response_model=RpcResponsePayload)
async def connector_terminal_resize_v2(
    connector_id: str,
    terminal_id: str,
    payload: TerminalResizeRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    result = await request_connector(
        manager,
        connector_id,
        "terminal.resize",
        {
            "terminalId": terminal_id,
            "sessionId": terminal_connector_scope_id(connector_id),
            "cols": payload.cols,
            "rows": payload.rows,
        },
        timeout=10,
    )
    return RpcResponsePayload(ok=True, result=result)


@router.post("/{connector_id}/terminals-v2/{terminal_id}/write", response_model=RpcResponsePayload)
async def connector_terminal_write_v2(
    connector_id: str,
    terminal_id: str,
    payload: dict[str, Any] = Body(default_factory=dict),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    data_base64 = payload.get("dataBase64")
    if not isinstance(data_base64, str):
        raise HTTPException(status_code=422, detail="dataBase64 is required")
    result = await request_connector(
        manager,
        connector_id,
        "terminal.write",
        {
            "terminalId": terminal_id,
            "sessionId": terminal_connector_scope_id(connector_id),
            "dataBase64": data_base64,
        },
        timeout=10,
    )
    return RpcResponsePayload(ok=True, result=result)


@router.get("/{connector_id}/terminals-v2/{terminal_id}/snapshot", response_model=RpcResponsePayload)
async def connector_terminal_snapshot_v2(
    connector_id: str,
    terminal_id: str,
    fromSeq: int = Query(default=0, ge=0),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await _require_owned_online_connector(connector_id, user_id, db, manager)
    result = await request_connector(
        manager,
        connector_id,
        "terminal.snapshot",
        {
            "terminalId": terminal_id,
            "sessionId": terminal_connector_scope_id(connector_id),
            "fromSeq": fromSeq,
        },
        timeout=10,
    )
    return RpcResponsePayload(ok=True, result=result)


@router.websocket("/{connector_id}/terminals-v2/{terminal_id}/stream")
async def connector_terminal_stream_v2(
    websocket: WebSocket,
    connector_id: str,
    terminal_id: str,
    fromSeq: int = Query(default=0, ge=0),
) -> None:
    token = websocket.query_params.get("token")
    auth_header = websocket.headers.get("authorization")
    if not token and auth_header and auth_header.startswith("Bearer "):
        token = auth_header[len("Bearer "):]
    if not token:
        await websocket.close(code=4401)
        return
    user_id = verify_user_access_token(urllib.parse.unquote(token))
    if user_id is None:
        await websocket.close(code=4401)
        return

    db: Store = websocket.app.state.store
    try:
        await _require_owned_connector(connector_id, user_id, db)
    except HTTPException:
        await websocket.close(code=4404)
        return

    manager: ConnectorRpcManager = websocket.app.state.rpc
    hub = websocket.app.state.terminal_stream_hub

    await websocket.accept()
    await hub.attach(connector_id, terminal_id, websocket)
    try:
        try:
            snapshot = await request_connector(
                manager,
                connector_id,
                "terminal.snapshot",
                {
                    "terminalId": terminal_id,
                    "sessionId": terminal_connector_scope_id(connector_id),
                    "fromSeq": fromSeq,
                },
                timeout=10,
            )
        except Exception as exc:
            code = getattr(exc, "status_code", 500)
            detail = getattr(exc, "detail", str(exc))
            await websocket.send_json({"type": "error", "code": code, "message": str(detail)})
            return

        terminal_snapshot = snapshot.get("terminal") if isinstance(snapshot, dict) else None
        data_b64 = snapshot.get("dataBase64") if isinstance(snapshot, dict) else None
        seq = snapshot.get("seq") if isinstance(snapshot, dict) else None
        if isinstance(data_b64, str):
            await websocket.send_json(
                {
                    "type": "replay",
                    "data": data_b64,
                    "seq": seq if isinstance(seq, int) else fromSeq,
                }
            )
        await hub.mark_ready(connector_id, terminal_id, websocket)

        if isinstance(terminal_snapshot, dict) and terminal_snapshot.get("status") == "exited":
            exit_code = terminal_snapshot.get("exitCode")
            await websocket.send_json(
                {
                    "type": "exit",
                    "exitCode": exit_code if isinstance(exit_code, int) else None,
                    "reason": "exit",
                }
            )

        while True:
            message = await websocket.receive_json()
            mtype = message.get("type")
            if mtype == "input":
                data_b64 = message.get("data")
                if not isinstance(data_b64, str):
                    continue
                try:
                    await request_connector(
                        manager,
                        connector_id,
                        "terminal.write",
                        {
                            "terminalId": terminal_id,
                            "sessionId": terminal_connector_scope_id(connector_id),
                            "dataBase64": data_b64,
                        },
                        timeout=5,
                    )
                except Exception as exc:
                    code = getattr(exc, "status_code", 500)
                    detail = getattr(exc, "detail", str(exc))
                    await websocket.send_json({"type": "error", "code": code, "message": str(detail)})
            elif mtype == "resize":
                try:
                    cols = int(message.get("cols") or 80)
                    rows = int(message.get("rows") or 24)
                except (TypeError, ValueError):
                    continue
                cols = max(1, min(500, cols))
                rows = max(1, min(200, rows))
                try:
                    await request_connector(
                        manager,
                        connector_id,
                        "terminal.resize",
                        {
                            "terminalId": terminal_id,
                            "sessionId": terminal_connector_scope_id(connector_id),
                            "cols": cols,
                            "rows": rows,
                        },
                        timeout=5,
                    )
                except Exception as exc:
                    code = getattr(exc, "status_code", 500)
                    detail = getattr(exc, "detail", str(exc))
                    await websocket.send_json({"type": "error", "code": code, "message": str(detail)})
            elif mtype == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        await hub.detach(connector_id, terminal_id, websocket)


@router.websocket("/{connector_id}/terminals/{terminal_id}/stream")
async def connector_terminal_stream(
    websocket: WebSocket,
    connector_id: str,
    terminal_id: str,
    fromSeq: int = Query(default=0, ge=0),
) -> None:
    token = websocket.query_params.get("token")
    auth_header = websocket.headers.get("authorization")
    if not token and auth_header and auth_header.startswith("Bearer "):
        token = auth_header[len("Bearer "):]
    if not token:
        await websocket.close(code=4401)
        return
    user_id = verify_user_access_token(urllib.parse.unquote(token))
    if user_id is None:
        await websocket.close(code=4401)
        return

    db: Store = websocket.app.state.store
    broker: TerminalBroker = websocket.app.state.terminal_broker
    try:
        await _require_owned_connector(connector_id, user_id, db)
    except HTTPException:
        await websocket.close(code=4404)
        return

    scope_id = terminal_connector_scope_id(connector_id)
    term = broker.get(terminal_id)
    if term is None or term.session_id != scope_id:
        await websocket.close(code=4404)
        return

    terminal_service = TerminalService(db, websocket.app.state.rpc, broker)
    await websocket.accept()
    await broker.attach_client(terminal_id, websocket, from_seq=fromSeq)
    await broker.send_to_connector(terminal_id, {"type": "attach"})
    try:
        while True:
            message = await websocket.receive_json()
            mtype = message.get("type")
            if mtype == "input":
                data_b64 = message.get("data")
                if not isinstance(data_b64, str):
                    continue
                if not await broker.send_to_connector(
                    terminal_id,
                    {"type": "input", "data": data_b64},
                ):
                    break
            elif mtype == "resize":
                cols = int(message.get("cols") or term.cols)
                rows = int(message.get("rows") or term.rows)
                cols = max(1, min(500, cols))
                rows = max(1, min(200, rows))
                await broker.resize(terminal_id, cols, rows)
                if not await broker.send_to_connector(
                    terminal_id,
                    {"type": "resize", "cols": cols, "rows": rows},
                ):
                    break
            elif mtype == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        broker.detach_client(terminal_id, websocket)
        term = broker.get(terminal_id)
        if term is not None and term.purpose == "user" and not term.clients:
            try:
                await terminal_service.close_for_connector(connector_id, terminal_id)
            except Exception:
                pass


# ── Device agents (attach / scan / delete) ─────────────────────────────────
#
# URL path kept as `/runtime-capabilities/...` for backward compatibility
# with already-shipped clients; the response shape is the new
# DeviceAgentsState frontend view. No `/refresh` endpoint exists by design —
# initial pair runs one full discovery, after that everything goes through
# explicit Add (scan) and Delete actions.


async def _require_owned_connector(connector_id: str, user_id: str, db: Store) -> None:
    try:
        connector = await db.get_connector(connector_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    if connector.userId != user_id:
        raise HTTPException(status_code=404, detail="connector not found")


async def _require_owned_online_connector(
    connector_id: str,
    user_id: str,
    db: Store,
    manager: ConnectorRpcManager,
) -> ConnectorView:
    try:
        connector = await db.get_connector(connector_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    if connector.userId != user_id:
        raise HTTPException(status_code=404, detail="connector not found")
    if not manager.is_online(connector_id):
        raise HTTPException(status_code=409, detail="connector is offline")
    return connector


def _quoted_filename(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', r"\"")
    return f'"{escaped}"'


def _safe_header_value(value: str) -> str:
    return value.encode("latin-1", errors="replace").decode("latin-1")


def _connector_scope_id(connector_id: str) -> str:
    return f"browse_{connector_id}"


def _user_id_from_authorization(authorization: str | None) -> str:
    prefix = "Bearer "
    if authorization is None or not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="missing user access token")
    user_id = verify_user_access_token(authorization[len(prefix) :])
    if user_id is None:
        raise HTTPException(status_code=401, detail="invalid user access token")
    return user_id


def _fs_preview_access_payload(token: str) -> dict[str, str]:
    payload = verify_signed_token(FS_PREVIEW_ACCESS_TOKEN_KIND, token)
    if payload is None:
        raise HTTPException(status_code=401, detail="invalid preview access token")
    user_id = str(payload.get("user_id") or "")
    connector_id = str(payload.get("connector_id") or "")
    root = str(payload.get("root") or "")
    path = str(payload.get("path") or "")
    if not user_id or not connector_id or not root or not path:
        raise HTTPException(status_code=401, detail="invalid preview access token")
    return {
        "user_id": user_id,
        "connector_id": connector_id,
        "root": root,
        "path": path,
    }


def _utc_now_plus_seconds(seconds: int) -> str:
    return (datetime.now(UTC) + timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")


async def _abandon_connector_shell_task(
    scope_id: str,
    task_id: str,
    connector_id: str,
    manager: ConnectorRpcManager,
    tasks: ShellTaskManager,
) -> None:
    task = tasks.abandon(task_id, session_id=scope_id)
    if task is None:
        return
    try:
        await manager.request(
            connector_id,
            "shell.task.cancel",
            {"taskId": task_id, "sessionId": scope_id},
            timeout=5,
        )
    except (ConnectorOfflineError, ConnectorRpcError, TimeoutError):
        logger.warning(
            "failed to cancel abandoned connector shell task task_id={} connector_id={}",
            task_id,
            connector_id,
        )


@router.get(
    "/{connector_id}/runtime-capabilities",
    response_model=ConnectorRuntimeCapabilitiesResponse,
)
async def get_connector_runtime_capabilities(
    connector_id: str,
    db: Store = Depends(get_store),
    user_id: str = Depends(current_user_id),
) -> ConnectorRuntimeCapabilitiesResponse:
    await _require_owned_connector(connector_id, user_id, db)
    state = await db.get_device_agents(connector_id)
    return ConnectorRuntimeCapabilitiesResponse(
        connectorId=connector_id,
        runtimeCapabilities=DeviceAgentsState.model_validate(state),
        serverTime=utc_now(),
    )


@router.get(
    "/{connector_id}/agents/{runtime}/settings",
    response_model=RuntimeSettingsResponse,
)
async def get_connector_agent_settings(
    connector_id: str,
    runtime: RuntimeName,
    settings_service: DeviceAgentSettingsService = Depends(get_device_agent_settings_service),
    user_id: str = Depends(current_user_id),
) -> RuntimeSettingsResponse:
    try:
        result = await settings_service.get_settings(
            connector_id,
            runtime,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return RuntimeSettingsResponse(
        connectorId=connector_id,
        runtime=runtime,
        settings=result.settings,
        schemaVersion=result.schema.schemaVersion,
        serverTime=utc_now(),
    )


@router.patch(
    "/{connector_id}/agents/{runtime}/settings",
    response_model=RuntimeSettingsResponse,
)
async def patch_connector_agent_settings(
    connector_id: str,
    runtime: RuntimeName,
    payload: RuntimeSettingsPatchRequest,
    settings_service: DeviceAgentSettingsService = Depends(get_device_agent_settings_service),
    user_id: str = Depends(current_user_id),
) -> RuntimeSettingsResponse:
    try:
        result = await settings_service.patch_settings(
            connector_id,
            runtime,
            payload.settings,
            user_id=user_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return RuntimeSettingsResponse(
        connectorId=connector_id,
        runtime=runtime,
        settings=result.settings,
        schemaVersion=result.schema.schemaVersion,
        serverTime=utc_now(),
    )


@router.post(
    "/{connector_id}/runtime-capabilities/scan",
    response_model=ConnectorRuntimeScanResponse,
)
async def scan_connector_runtime(
    connector_id: str,
    payload: ConnectorRuntimeScanRequest,
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    user_id: str = Depends(current_user_id),
) -> ConnectorRuntimeScanResponse:
    """Scan a single runtime, with an optional user-supplied custom path.

    Backs the Add Agent modal. Three outcomes for the user:

      - Daemon found a usable binary → desired intent becomes enabled,
        active runtimes are pushed to the connector, and sessions for the
        runtime get force-resynced from local files.
      - Daemon found something but the check failed → desired intent still
        becomes enabled so the Device page can show a warning row, but the
        runtime is not active until execution becomes available.
      - Nothing on this machine → modal shows the inline "couldn't find"
        chip; we don't enable the runtime. Frontend renders the chip from
        the `scanned.report` we return.

    "Agent not found" and "check failed" are NOT HTTP errors — the modal
    needs to render them inline. We only raise 5xx for real plumbing
    errors (daemon offline, dispatch crash).
    """
    await _require_owned_connector(connector_id, user_id, db)
    if not manager.is_online(connector_id):
        raise HTTPException(
            status_code=503,
            detail={
                "code": "connector_offline",
                "message": "connector is offline; bring it back online to scan",
            },
        )
    # 90s covers per-runtime discovery (~1s) + force-resync of just that
    # runtime's sessions (5-9s codex worst case). The Scan button surfaces
    # this as a spinner, so a longer wait is fine.
    try:
        result = await manager.request(
            connector_id,
            "capabilities.scanRuntime",
            {"runtime": payload.runtime, "path": payload.path},
            timeout=90,
        )
    except ConnectorOfflineError as exc:
        raise HTTPException(
            status_code=503, detail={"code": "connector_offline", "message": str(exc)}
        ) from exc
    except ConnectorRpcError as exc:
        if exc.code == "ValueError":
            raise HTTPException(
                status_code=400,
                detail={"code": "unsupported_runtime", "message": exc.message},
            ) from exc
        raise HTTPException(
            status_code=502, detail={"code": exc.code, "message": exc.message}
        ) from exc
    if not isinstance(result, dict) or not isinstance(result.get("report"), dict):
        raise HTTPException(
            status_code=502,
            detail={"code": "invalid_response", "message": "connector returned malformed scan result"},
        )

    runtime = str(result.get("runtime") or payload.runtime)
    report = dict(result["report"])

    # Only commit desired intent if the scan actually turned up something
    # the user can interact with. All-missing reports are pure "we looked
    # and didn't find it" feedback for the modal; persisting them would
    # clutter the Device → Agents list with greyed-out rows.
    if report_is_attachable(report):
        try:
            state = await db.attach_runtime(connector_id, runtime, report, user_id=user_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="connector not found") from None
        active_runtimes = await send_active_runtimes(manager, db, connector_id)
        if active_runtimes is None or runtime in active_runtimes:
            asyncio.create_task(
                _send_force_resync_runtime(manager, connector_id, runtime)
            )
    else:
        try:
            state = await db.observe_runtime(connector_id, runtime, report, user_id=user_id)
        except KeyError:
            raise HTTPException(status_code=404, detail="connector not found") from None

    return ConnectorRuntimeScanResponse(
        connectorId=connector_id,
        runtimeCapabilities=DeviceAgentsState.model_validate(state),
        scanned={"runtime": runtime, "report": report},
        serverTime=utc_now(),
    )


@router.delete(
    "/{connector_id}/runtime-capabilities/{runtime}",
    response_model=ConnectorRuntimeCapabilitiesResponse,
)
async def delete_connector_runtime_capability(
    connector_id: str,
    runtime: str,
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    user_id: str = Depends(current_user_id),
) -> ConnectorRuntimeCapabilitiesResponse:
    """Delete an agent from this device.

    "Delete" here means: set desired intent to disabled
    (so the daemon's next discovery push doesn't auto-resurrect it),
    cascade-delete every chat session it owns + their timeline/approvals/
    file blobs. The user's local install is untouched — clicking Add later
    is the only path to bring it back.

    We also fire a `capabilities.invalidateRuntime` RPC at the daemon as
    a fast-path optimization: it makes the live daemon stop its periodic
    sync for this runtime within ~1s instead of waiting for the next
    discovery cycle. Best-effort: if the daemon is offline or slow, the
    HTTP response still succeeds — desired intent in the DB will catch it on
    the next reconnect.
    """
    try:
        state = await db.detach_runtime(connector_id, runtime, user_id=user_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="connector not found") from None
    logger.info(
        "detached runtime connector_id={} runtime={} user_id={}",
        connector_id,
        runtime,
        user_id,
    )
    if manager.is_online(connector_id):
        await send_active_runtimes(manager, db, connector_id)
        asyncio.create_task(_send_invalidate_runtime(manager, connector_id, runtime))
    return ConnectorRuntimeCapabilitiesResponse(
        connectorId=connector_id,
        runtimeCapabilities=DeviceAgentsState.model_validate(state),
        serverTime=utc_now(),
    )


@router.post(
    "/{connector_id}/sessions/archive-all",
    response_model=ArchiveAllResponse,
)
async def archive_all_device_sessions(
    connector_id: str,
    payload: ArchiveAllRequest,
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    user_id: str = Depends(current_user_id),
) -> ArchiveAllResponse:
    await _require_owned_connector(connector_id, user_id, db)
    try:
        sessions = await db.archive_device_sessions(
            connector_id,
            payload.archived,
            scope=payload.scope,
            user_id=user_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return ArchiveAllResponse(
        sessions=[with_effective_session_connector_status(manager, session) for session in sessions],
        affected=len(sessions),
        serverTime=utc_now(),
    )
