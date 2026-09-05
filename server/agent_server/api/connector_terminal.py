from __future__ import annotations

import secrets
import urllib.parse
from typing import Any

from fastapi import (
    APIRouter,
    Body,
    Depends,
    HTTPException,
    Query,
    WebSocket,
    WebSocketDisconnect,
)

from agent_server.api.connector_common import (
    require_owned_connector,
    require_owned_online_connector,
)
from agent_server.core.auth import (
    verify_user_access_token,
)
from agent_server.core.models import (
    RpcResponsePayload,
    TerminalCreateRequest,
    TerminalListResponse,
    TerminalPatchRequest,
    TerminalPersistenceRequest,
    TerminalResizeRequest,
    TerminalResponse,
)
from agent_server.core.utc import utc_now
from agent_server.deps import (
    current_user_id,
    get_rpc,
    get_store,
    get_terminal_service,
)
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.repositories.facade import Store
from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.services.connector_rpc import ConnectorUpstreamError
from agent_server.services.terminal import (
    TerminalService,
    TerminalServiceError,
    terminal_connector_scope_id,
)
from agent_server.services.workspace import request_connector, resolve_workspace_path

router = APIRouter(prefix="/connectors", tags=["connector-terminal"])


def _raise_terminal_service_error(exc: TerminalServiceError) -> None:
    raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc


def _normalize_terminal_v2_view(
    terminal: Any,
    *,
    session_id: str,
    terminal_id: str | None = None,
    root: str | None = None,
    cwd: str | None = None,
    label: str | None = None,
    cols: int | None = None,
    rows: int | None = None,
) -> dict[str, Any]:
    item = dict(terminal) if isinstance(terminal, dict) else {}
    if terminal_id is not None:
        item.setdefault("terminalId", terminal_id)
    item.setdefault("sessionId", session_id)
    if root is not None:
        item["root"] = root
    elif not isinstance(item.get("root"), str) or not item["root"].strip():
        item["root"] = (
            item.get("cwd")
            if isinstance(item.get("cwd"), str) and item["cwd"].strip()
            else "."
        )
    if cwd is not None:
        item.setdefault("cwd", cwd)
    else:
        item.setdefault("cwd", item["root"])
    item.setdefault("label", label or "Shell")
    item.setdefault("purpose", "user")
    item.setdefault("pid", None)
    item.setdefault("cols", cols or 80)
    item.setdefault("rows", rows or 24)
    item.setdefault("status", "exited" if item.get("closed") else "running")
    item.setdefault("exitCode", None)
    item.setdefault("scrollbackBytes", 0)
    item.setdefault("scrollbackSeq", 0)
    item.setdefault("persistent", False)
    item.setdefault("createdAt", utc_now())
    return item


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
    await require_owned_online_connector(connector_id, user_id, db, manager)
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
    await require_owned_online_connector(connector_id, user_id, db, manager)
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
            "persistent": payload.persistent,
        },
        timeout=15,
    )
    await db.record_connector_terminal_root(
        connector_id=connector_id,
        terminal_id=terminal_id,
        session_id=scope_id,
        root=root,
        cwd=cwd,
    )
    if isinstance(result, dict):
        result = _normalize_terminal_v2_view(
            result,
            session_id=scope_id,
            terminal_id=terminal_id,
            root=root,
            cwd=cwd,
            label=payload.label or "Shell",
            cols=payload.cols,
            rows=payload.rows,
        )
    return RpcResponsePayload(ok=True, result=result)


@router.get("/{connector_id}/terminals", response_model=TerminalListResponse)
async def connector_terminal_list(
    connector_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    terminal_service: TerminalService = Depends(get_terminal_service),
) -> TerminalListResponse:
    await require_owned_connector(connector_id, user_id, db)
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
    await require_owned_online_connector(connector_id, user_id, db, manager)
    scope_id = terminal_connector_scope_id(connector_id)
    result = await request_connector(
        manager,
        connector_id,
        "terminal.list",
        {"sessionId": scope_id},
        timeout=10,
    )
    if isinstance(result, dict) and isinstance(result.get("terminals"), list):
        root_by_id = await db.list_connector_terminal_roots(
            connector_id=connector_id,
            session_id=scope_id,
        )
        live_ids: set[str] = set()
        terminals: list[dict[str, Any]] = []
        for item in result["terminals"]:
            terminal_id = item.get("terminalId") if isinstance(item, dict) else None
            meta = root_by_id.get(terminal_id) if isinstance(terminal_id, str) else None
            if isinstance(terminal_id, str):
                live_ids.add(terminal_id)
            terminals.append(
                _normalize_terminal_v2_view(
                    item,
                    session_id=scope_id,
                    root=meta["root"] if meta is not None else None,
                    cwd=meta["cwd"] if meta is not None else None,
                )
            )
        await db.prune_connector_terminal_roots(
            connector_id=connector_id,
            session_id=scope_id,
            terminal_ids=live_ids,
        )
        result = {
            **result,
            "terminals": terminals,
        }
    return RpcResponsePayload(ok=True, result=result)


@router.patch(
    "/{connector_id}/terminals/{terminal_id}", response_model=TerminalResponse
)
async def connector_terminal_rename(
    connector_id: str,
    terminal_id: str,
    payload: TerminalPatchRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    terminal_service: TerminalService = Depends(get_terminal_service),
) -> TerminalResponse:
    await require_owned_connector(connector_id, user_id, db)
    try:
        return await terminal_service.rename_for_connector(
            connector_id, terminal_id, payload
        )
    except TerminalServiceError as exc:
        _raise_terminal_service_error(exc)


@router.patch(
    "/{connector_id}/terminals-v2/{terminal_id}", response_model=RpcResponsePayload
)
async def connector_terminal_rename_v2(
    connector_id: str,
    terminal_id: str,
    payload: TerminalPatchRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await require_owned_online_connector(connector_id, user_id, db, manager)
    scope_id = terminal_connector_scope_id(connector_id)
    result = await request_connector(
        manager,
        connector_id,
        "terminal.rename",
        {
            "terminalId": terminal_id,
            "sessionId": scope_id,
            "label": payload.label,
        },
        timeout=10,
    )
    if isinstance(result, dict):
        meta = await db.get_connector_terminal_root(
            connector_id=connector_id,
            terminal_id=terminal_id,
        )
        result = _normalize_terminal_v2_view(
            result,
            session_id=scope_id,
            terminal_id=terminal_id,
            root=meta["root"] if meta is not None else None,
            cwd=meta["cwd"] if meta is not None else None,
        )
    return RpcResponsePayload(ok=True, result=result)


@router.patch(
    "/{connector_id}/terminals-v2/{terminal_id}/persistence",
    response_model=RpcResponsePayload,
)
async def connector_terminal_set_persistence_v2(
    connector_id: str,
    terminal_id: str,
    payload: TerminalPersistenceRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await require_owned_online_connector(connector_id, user_id, db, manager)
    scope_id = terminal_connector_scope_id(connector_id)
    try:
        result = await request_connector(
            manager,
            connector_id,
            "terminal.setPersistent",
            {
                "terminalId": terminal_id,
                "sessionId": scope_id,
                "persistent": payload.persistent,
            },
            timeout=10,
        )
    except ConnectorUpstreamError as exc:
        if getattr(exc.__cause__, "code", None) == "terminal_not_found":
            await db.forget_connector_terminal_root(
                connector_id=connector_id,
                terminal_id=terminal_id,
            )
            raise HTTPException(status_code=404, detail="terminal not found") from exc
        raise
    if isinstance(result, dict):
        meta = await db.get_connector_terminal_root(
            connector_id=connector_id,
            terminal_id=terminal_id,
        )
        result = _normalize_terminal_v2_view(
            result,
            session_id=scope_id,
            terminal_id=terminal_id,
            root=meta["root"] if meta is not None else None,
            cwd=meta["cwd"] if meta is not None else None,
        )
    return RpcResponsePayload(ok=True, result=result)


@router.delete(
    "/{connector_id}/terminals/{terminal_id}", response_model=TerminalResponse
)
async def connector_terminal_close(
    connector_id: str,
    terminal_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    terminal_service: TerminalService = Depends(get_terminal_service),
) -> TerminalResponse:
    await require_owned_online_connector(connector_id, user_id, db, manager)
    try:
        return await terminal_service.close_for_connector(connector_id, terminal_id)
    except TerminalServiceError as exc:
        _raise_terminal_service_error(exc)


@router.delete(
    "/{connector_id}/terminals-v2/{terminal_id}", response_model=RpcResponsePayload
)
async def connector_terminal_close_v2(
    connector_id: str,
    terminal_id: str,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await require_owned_online_connector(connector_id, user_id, db, manager)
    result = await request_connector(
        manager,
        connector_id,
        "terminal.close",
        {
            "terminalId": terminal_id,
            "sessionId": terminal_connector_scope_id(connector_id),
        },
        timeout=10,
    )
    await db.forget_connector_terminal_root(
        connector_id=connector_id, terminal_id=terminal_id
    )
    return RpcResponsePayload(ok=True, result=result)


@router.post(
    "/{connector_id}/terminals/{terminal_id}/resize", response_model=TerminalResponse
)
async def connector_terminal_resize(
    connector_id: str,
    terminal_id: str,
    payload: TerminalResizeRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    terminal_service: TerminalService = Depends(get_terminal_service),
) -> TerminalResponse:
    await require_owned_online_connector(connector_id, user_id, db, manager)
    try:
        return await terminal_service.resize_for_connector(
            connector_id, terminal_id, payload
        )
    except TerminalServiceError as exc:
        _raise_terminal_service_error(exc)


@router.post(
    "/{connector_id}/terminals-v2/{terminal_id}/resize",
    response_model=RpcResponsePayload,
)
async def connector_terminal_resize_v2(
    connector_id: str,
    terminal_id: str,
    payload: TerminalResizeRequest,
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await require_owned_online_connector(connector_id, user_id, db, manager)
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


@router.post(
    "/{connector_id}/terminals-v2/{terminal_id}/write",
    response_model=RpcResponsePayload,
)
async def connector_terminal_write_v2(
    connector_id: str,
    terminal_id: str,
    payload: dict[str, Any] = Body(default_factory=dict),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await require_owned_online_connector(connector_id, user_id, db, manager)
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


@router.get(
    "/{connector_id}/terminals-v2/{terminal_id}/snapshot",
    response_model=RpcResponsePayload,
)
async def connector_terminal_snapshot_v2(
    connector_id: str,
    terminal_id: str,
    fromSeq: int = Query(default=0, ge=0),
    user_id: str = Depends(current_user_id),
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
) -> RpcResponsePayload:
    await require_owned_online_connector(connector_id, user_id, db, manager)
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
    if isinstance(result, dict) and isinstance(result.get("terminal"), dict):
        meta = await db.get_connector_terminal_root(
            connector_id=connector_id,
            terminal_id=terminal_id,
        )
        result = {
            **result,
            "terminal": _normalize_terminal_v2_view(
                result["terminal"],
                session_id=terminal_connector_scope_id(connector_id),
                terminal_id=terminal_id,
                root=meta["root"] if meta is not None else None,
                cwd=meta["cwd"] if meta is not None else None,
            ),
        }
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
        token = auth_header[len("Bearer ") :]
    if not token:
        await websocket.close(code=4401)
        return
    user_id = verify_user_access_token(urllib.parse.unquote(token))
    if user_id is None:
        await websocket.close(code=4401)
        return

    db: Store = websocket.app.state.store
    try:
        await require_owned_connector(connector_id, user_id, db)
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
            await websocket.send_json(
                {"type": "error", "code": code, "message": str(detail)}
            )
            return

        terminal_snapshot = (
            snapshot.get("terminal") if isinstance(snapshot, dict) else None
        )
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

        if (
            isinstance(terminal_snapshot, dict)
            and terminal_snapshot.get("status") == "exited"
        ):
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
                    await websocket.send_json(
                        {"type": "error", "code": code, "message": str(detail)}
                    )
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
                    await websocket.send_json(
                        {"type": "error", "code": code, "message": str(detail)}
                    )
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
        token = auth_header[len("Bearer ") :]
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
        await require_owned_connector(connector_id, user_id, db)
    except HTTPException:
        await websocket.close(code=4404)
        return

    scope_id = terminal_connector_scope_id(connector_id)
    term = await broker.get(terminal_id)
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
        await broker.detach_client(terminal_id, websocket)
        term = await broker.get(terminal_id)
        if (
            term is not None
            and term.purpose == "user"
            and not await broker.has_clients(terminal_id)
        ):
            try:
                await terminal_service.close_for_connector(connector_id, terminal_id)
            except Exception:
                pass
