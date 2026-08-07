from __future__ import annotations

import base64
from typing import Any

from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
)
from loguru import logger
from starlette.requests import HTTPConnection

from agent_server.core.auth import (
    DEFAULT_EXPIRES_IN,
    create_connector_access_token,
    verify_connector_access_token,
)
from agent_server.core.models import (
    ConnectorAuthResponse,
    ConnectorIngestRequest,
    ConnectorIngestResponse,
)
from agent_server.deps import (
    get_attachment_service,
    get_connector_ingest_service,
    get_connector_realtime_service,
    get_fs_downloads,
    get_rpc,
    get_store,
    get_timeline_broker,
)
from agent_server.infra.connector_rpc import (
    ConnectorRpcManager,
    DuplicateConnectorConnectionError,
)
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.infra.repositories.facade import Store
from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.attachments import AttachmentService
from agent_server.services.connector_ingest import ConnectorIngestService
from agent_server.services.connector_notifications import (
    ConnectorNotificationService,
    NotificationValidationError,
)
from agent_server.services.connector_realtime import ConnectorRealtimeService
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.effective_capabilities import (
    publish_connector_session_capabilities,
)

router = APIRouter(tags=["connector-ingress"])


@router.post("/connector/auth", response_model=ConnectorAuthResponse)
async def connector_auth(
    authorization: str = Header(..., alias="Authorization"),
    db: Store = Depends(get_store),
) -> ConnectorAuthResponse:
    connector_id, token = _parse_connector_authorization(authorization)
    if not await db.verify_connector_token(connector_id, token):
        raise HTTPException(status_code=401, detail="invalid connector credential")
    return ConnectorAuthResponse(
        accessToken=create_connector_access_token(connector_id),
        expiresIn=DEFAULT_EXPIRES_IN,
    )


def get_terminal_broker(conn: HTTPConnection) -> TerminalBroker:
    return conn.app.state.terminal_broker


@router.post("/connector/ingest", response_model=ConnectorIngestResponse)
async def connector_ingest(
    payload: ConnectorIngestRequest,
    authorization: str = Header(..., alias="Authorization"),
    db: Store = Depends(get_store),
    ingest_service: ConnectorIngestService = Depends(get_connector_ingest_service),
) -> ConnectorIngestResponse:
    connector_id = _connector_id_from_bearer(authorization)
    await _require_active_connector(connector_id, db)
    try:
        return await ingest_service.ingest(connector_id=connector_id, payload=payload)
    except NotificationValidationError as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": exc.code, "message": exc.message},
        ) from exc


@router.get("/connector/sessions/{session_id}/attachments/{file_id}/content")
async def connector_attachment_content(
    session_id: str,
    file_id: str,
    authorization: str = Header(..., alias="Authorization"),
    db: Store = Depends(get_store),
    attachments: AttachmentService = Depends(get_attachment_service),
) -> Response:
    """Connector-side download of a user-uploaded attachment.

    The blob remains in platform storage after connector consumption. Two
    response headers carry metadata the connector needs without spelunking
    through a JSON envelope:

      X-File-Name      original upload filename
      X-File-Sha256    sha256 hex of the bytes in the body
    """
    connector_id = _connector_id_from_bearer(authorization)
    await _require_active_connector(connector_id, db)
    await db.record_connector_activity(connector_id)
    try:
        data, metadata = await attachments.read_connector_attachment(
            session_id=session_id,
            file_id=file_id,
            connector_id=connector_id,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="file not found") from None
    except ValueError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return Response(
        content=data,
        media_type=metadata.get("mediaType") or "application/octet-stream",
        headers={
            "X-File-Name": _safe_header_value(metadata.get("name") or file_id),
            "X-File-Sha256": str(metadata.get("sha256") or ""),
        },
    )


@router.put("/connector/fs/transfers/{transfer_id}")
async def connector_fs_transfer_upload(
    transfer_id: str,
    request: Request,
    token: str,
    authorization: str = Header(..., alias="Authorization"),
    db: Store = Depends(get_store),
    downloads: FsDownloadRelayManager = Depends(get_fs_downloads),
) -> dict[str, str]:
    connector_id = _connector_id_from_bearer(authorization)
    await _require_active_connector(connector_id, db)
    await db.record_connector_activity(connector_id)
    transfer = await downloads.get(transfer_id, token)
    if transfer is None or transfer.connector_id != connector_id:
        raise HTTPException(status_code=404, detail="transfer not found")
    accepted = await downloads.upload(
        transfer_id=transfer_id,
        token=token,
        chunks=request.stream(),
    )
    if not accepted:
        raise HTTPException(status_code=404, detail="transfer not found")
    return {"status": "accepted"}


def _safe_header_value(value: str) -> str:
    # HTTP header values must be latin-1; drop anything fancier. The connector
    # already knows the canonical name from its turn.start request — this is
    # only a debug aid.
    return value.encode("latin-1", errors="replace").decode("latin-1")


@router.websocket("/connector/ws")
async def connector_ws(
    websocket: WebSocket,
    db: Store = Depends(get_store),
    manager: ConnectorRpcManager = Depends(get_rpc),
    realtime: ConnectorRealtimeService = Depends(get_connector_realtime_service),
    broker: TerminalBroker = Depends(get_terminal_broker),
    timeline_broker: TimelineBroker = Depends(get_timeline_broker),
) -> None:
    auth_header = websocket.headers.get("authorization")
    connector_id = _connector_id_from_bearer(auth_header)
    if connector_id is None:
        await websocket.close(code=1008)
        return
    try:
        await db.get_connector(connector_id)
    except KeyError:
        await websocket.close(code=1008, reason="invalid connector access token")
        return

    try:
        connection = await manager.register(connector_id, websocket)
    except DuplicateConnectorConnectionError:
        await websocket.close(code=4409, reason="connector id already connected")
        logger.warning("rejected duplicate connector websocket: {}", connector_id)
        return
    try:
        recorded_connection = await db.record_connector_connection(
            connector_id,
            device_os=_connector_device_os(websocket.headers.get("x-device-os")),
        )
    except Exception:  # noqa: BLE001 - release the lease before propagating startup failure
        await manager.unregister(connector_id, connection)
        raise
    if not recorded_connection:
        await manager.unregister(connector_id, connection)
        await websocket.close(code=1008, reason="connector was revoked")
        return
    await db.record_connector_activity(connector_id)
    await publish_dashboard_changed(
        db,
        timeline_broker,
        connector_id=connector_id,
        reason="connector.online",
    )
    # Complete server-side connection setup before the browser-side test or
    # connector can observe an accepted socket and immediately query stale
    # device metadata.
    await websocket.accept()
    await publish_connector_session_capabilities(
        db,
        manager,
        timeline_broker,
        connector_id,
    )
    ingest_service = ConnectorIngestService(
        db,
        ConnectorNotificationService(db, realtime),
        timeline_broker,
        websocket.app.state.device_runtime_service,
        manager,
        websocket.app.state.session_runtime_state_cache,
    )
    logger.info("connector connected: {}", connector_id)
    try:
        while True:
            message = await websocket.receive_json()
            if not await manager.touch(connector_id, connection):
                break
            await _handle_connector_message(
                connector_id, message, manager, ingest_service
            )
    except WebSocketDisconnect:
        logger.info("connector disconnected: {}", connector_id)
    finally:
        removed_terminals = await broker.remove_ephemeral_for_connector(connector_id)
        if removed_terminals:
            logger.info(
                "removed ephemeral terminals after connector websocket ended "
                "connector_id={} count={}",
                connector_id,
                len(removed_terminals),
            )
        await manager.unregister(connector_id, connection)
        await publish_connector_session_capabilities(
            db,
            manager,
            timeline_broker,
            connector_id,
        )
        await publish_dashboard_changed(
            db,
            timeline_broker,
            connector_id=connector_id,
            reason="connector.presence",
        )


def _connector_device_os(value: str | None) -> str | None:
    normalized = (value or "").strip().lower()
    return normalized if normalized in {"macos", "windows", "linux"} else None


@router.websocket("/connector/terminals/{terminal_id}/relay")
async def connector_terminal_relay_ws(
    websocket: WebSocket,
    terminal_id: str,
    broker: TerminalBroker = Depends(get_terminal_broker),
) -> None:
    token = websocket.query_params.get("token")
    if not isinstance(token, str) or not token:
        await websocket.close(code=1008)
        return
    term = await broker.get(terminal_id)
    if term is None:
        await websocket.close(code=1008, reason="terminal not found")
        return
    if term.relay_token != token:
        await websocket.close(code=1008, reason="invalid terminal relay token")
        return

    await websocket.accept()
    if await broker.attach_connector(terminal_id, token, websocket) is None:
        await websocket.close(code=1008, reason="invalid terminal relay token")
        return
    await websocket.send_json(
        {
            "type": "start",
            "terminalId": term.id,
            "sessionId": term.session_id,
            "root": term.root,
            "cwd": term.cwd,
            "shell": term.shell or None,
            "command": term.command,
            "args": term.args,
            "profile": term.profile,
            "cols": term.cols,
            "rows": term.rows,
            "env": term.env,
        }
    )
    try:
        while True:
            message = await websocket.receive_json()
            mtype = message.get("type")
            if mtype == "ready":
                pid = message.get("pid")
                await broker.mark_running(
                    terminal_id, pid=pid if isinstance(pid, int) else None
                )
            elif mtype == "output":
                data_b64 = message.get("data")
                seq = message.get("seq")
                if isinstance(data_b64, str) and isinstance(seq, int):
                    try:
                        data = base64.b64decode(data_b64)
                    except Exception:
                        data = b""
                    if data:
                        await broker.on_output(terminal_id, data=data, seq=seq)
            elif mtype == "exit":
                exit_code = message.get("exitCode")
                reason = (
                    message.get("reason")
                    if isinstance(message.get("reason"), str)
                    else None
                )
                await broker.on_exited(
                    terminal_id,
                    exit_code=exit_code if isinstance(exit_code, int) else None,
                    reason=reason,
                )
                break
    except WebSocketDisconnect:
        pass
    finally:
        await broker.detach_connector(terminal_id, websocket)


async def _handle_connector_message(
    connector_id: str,
    message: dict[str, Any],
    manager: ConnectorRpcManager,
    ingest_service: ConnectorIngestService,
) -> None:
    message_type = message.get("type")
    if message_type == "response":
        manager.resolve_response(connector_id, message)
        return
    if message_type != "notification":
        return

    method = message.get("method")
    params = message.get("params") or {}
    if isinstance(method, str) and isinstance(params, dict):
        await ingest_service.handle_notification_message(
            connector_id=connector_id,
            method=method,
            params=params,
        )


def _parse_connector_authorization(authorization: str) -> tuple[str, str]:
    prefix = "Connector "
    if not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="expected Connector authorization")
    credential = authorization[len(prefix) :]
    if ":" not in credential:
        raise HTTPException(
            status_code=401, detail="invalid connector credential format"
        )
    connector_id, token = credential.split(":", 1)
    return connector_id, token


def _connector_id_from_bearer(authorization: str | None) -> str | None:
    prefix = "Bearer "
    if authorization is None or not authorization.startswith(prefix):
        return None
    return verify_connector_access_token(authorization[len(prefix) :])


async def _require_active_connector(connector_id: str | None, db: Store) -> str:
    if connector_id is None:
        raise HTTPException(status_code=401, detail="invalid connector access token")
    try:
        await db.get_connector(connector_id)
    except KeyError:
        raise HTTPException(
            status_code=401, detail="invalid connector access token"
        ) from None
    return connector_id
