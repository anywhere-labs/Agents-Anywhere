from __future__ import annotations

import asyncio
import base64
import time
from dataclasses import dataclass
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
    get_timeline_write_buffer,
)
from agent_server.infra.connector_rpc import (
    ConnectorConnection,
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
from agent_server.services.device_runtimes import (
    DeviceRuntimeError,
    DeviceRuntimeService,
)
from agent_server.services.effective_capabilities import (
    publish_connector_session_capabilities,
)
from agent_server.services.timeline_write_buffer import TimelineWriteBuffer

router = APIRouter(tags=["connector-ingress"])


@dataclass(frozen=True)
class _NotificationBarrier:
    completed: asyncio.Future[None]


class _ConnectorNotificationPump:
    def __init__(
        self,
        connector_id: str,
        ingest_service: ConnectorIngestService,
        *,
        connection_id: str | None = None,
    ) -> None:
        self._connector_id = connector_id
        self._connection_id = connection_id
        self._ingest_service = ingest_service
        self._queue: asyncio.Queue[
            tuple[str, dict[str, Any]] | _NotificationBarrier | None
        ] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None

    @property
    def task(self) -> asyncio.Task[None]:
        if self._task is None:
            raise RuntimeError("connector notification pump is not started")
        return self._task

    def start(self) -> None:
        if self._task is not None:
            raise RuntimeError("connector notification pump is already started")
        self._task = asyncio.create_task(
            self._run(),
            name=f"connector-notifications-{self._connector_id}",
        )

    def enqueue_message(self, message: dict[str, Any]) -> None:
        if self._task is not None and self._task.done():
            self._task.result()
            raise RuntimeError("connector notification pump stopped unexpectedly")
        method = message.get("method")
        params = message.get("params") or {}
        if isinstance(method, str) and isinstance(params, dict):
            self._queue.put_nowait((method, params))

    async def close(self) -> None:
        if self._task is None:
            return
        if not self._task.done():
            self._queue.put_nowait(None)
        await asyncio.gather(self._task, return_exceptions=True)

    async def flush(self) -> None:
        task = self.task
        if task.done():
            await task
            raise RuntimeError("connector notification pump stopped unexpectedly")
        completed: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self._queue.put_nowait(_NotificationBarrier(completed))
        done, _pending = await asyncio.wait(
            {task, completed},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if task in done:
            await task
            raise RuntimeError("connector notification pump stopped unexpectedly")
        await completed

    async def _run(self) -> None:
        try:
            while True:
                notification = await self._queue.get()
                if notification is None:
                    return
                if isinstance(notification, _NotificationBarrier):
                    if not notification.completed.done():
                        notification.completed.set_result(None)
                    continue
                method, params = notification
                started_at = time.monotonic()
                try:
                    await self._ingest_service.handle_notification_message(
                        connector_id=self._connector_id,
                        method=method,
                        params=params,
                        connection_id=self._connection_id,
                    )
                except Exception:
                    logger.exception(
                        "connector notification rejected connector_id={} method={}",
                        self._connector_id,
                        method,
                    )
                    continue
                elapsed_ms = (time.monotonic() - started_at) * 1000
                if method == "timeline.itemUpsert" or elapsed_ms >= 100:
                    logger.info(
                        "connector notification handled connector_id={} method={} session_id={} elapsed_ms={:.1f}",
                        self._connector_id,
                        method,
                        params.get("sessionId"),
                        elapsed_ms,
                    )
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "connector notification worker failed connector_id={}",
                self._connector_id,
            )
            raise


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
    # already knows the canonical name from its session send request — this is
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
    timeline_write_buffer: TimelineWriteBuffer = Depends(
        get_timeline_write_buffer
    ),
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
        connection = await manager.register(connector_id, websocket, ready=False)
    except DuplicateConnectorConnectionError:
        await websocket.close(code=4409, reason="connector id already connected")
        logger.warning("rejected duplicate connector websocket: {}", connector_id)
        return
    runtime_service: DeviceRuntimeService = websocket.app.state.device_runtime_service
    try:
        recorded_connection = await db.record_connector_connection(
            connector_id,
            device_os=_connector_device_os(websocket.headers.get("x-device-os")),
        )
        if not recorded_connection:
            await websocket.close(code=1008, reason="connector was revoked")
            return
        await db.record_connector_activity(connector_id)
        # Finish authentication and registration before making this socket routable.
        await websocket.accept()
        if not await manager.mark_ready(connection):
            await websocket.close(code=4409, reason="connector ownership was lost")
            return
    finally:
        if not connection.ready:
            await manager.unregister(connector_id, connection)

    discovery_task: asyncio.Task[str | None] | None = None
    flush_task: asyncio.Task[None] | None = None
    completion_task: asyncio.Task[None] | None = None
    reader_task: asyncio.Task[None] | None = None
    notification_pump: _ConnectorNotificationPump | None = None
    try:
        await publish_dashboard_changed(
            db,
            timeline_broker,
            connector_id=connector_id,
            reason="connector.online",
        )
        await publish_connector_session_capabilities(
            db,
            manager,
            timeline_broker,
            connector_id,
        )
        ingest_service = ConnectorIngestService(
            db,
            ConnectorNotificationService(db, realtime, timeline_write_buffer),
            timeline_broker,
            runtime_service,
            manager,
            websocket.app.state.session_runtime_state_cache,
        )
        notification_pump = _ConnectorNotificationPump(
            connector_id,
            ingest_service,
            connection_id=connection.connection_id,
        )
        notification_pump.start()
        # Discovery refreshes provider metadata independently of request routing.
        discovery_task = asyncio.create_task(
            _discover_runtimes(
                runtime_service,
                connector_id,
                connection,
            ),
            name=f"runtime-discover-{connection.connection_id}",
        )
        logger.info("connector connected: {}", connector_id)
        reader_task = asyncio.create_task(
            _read_connector_messages(
                websocket,
                connector_id,
                connection,
                manager,
                notification_pump,
            ),
            name=f"connector-reader-{connection.connection_id}",
        )
        done, _pending = await asyncio.wait(
            {reader_task, discovery_task, notification_pump.task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if notification_pump.task in done:
            await notification_pump.task
            raise RuntimeError("connector notification worker stopped unexpectedly")
        if reader_task in done:
            await reader_task
            return

        discovery_reason = await discovery_task
        flush_task = asyncio.create_task(
            notification_pump.flush(),
            name=f"runtime-discovery-flush-{connection.connection_id}",
        )
        done, _pending = await asyncio.wait(
            {reader_task, flush_task, notification_pump.task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if notification_pump.task in done:
            await notification_pump.task
            raise RuntimeError("connector notification worker stopped unexpectedly")
        if reader_task in done:
            await reader_task
            return
        await flush_task
        completion_task = asyncio.create_task(
            _complete_runtime_discovery(
                runtime_service,
                connector_id,
                connection,
                reason=discovery_reason or "runtime.recovery",
            ),
            name=f"runtime-discovery-complete-{connection.connection_id}",
        )
        done, _pending = await asyncio.wait(
            {reader_task, notification_pump.task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if reader_task in done:
            await reader_task
            return
        if notification_pump.task in done:
            await notification_pump.task
            raise RuntimeError("connector notification worker stopped unexpectedly")
    except WebSocketDisconnect:
        logger.info("connector disconnected: {}", connector_id)
    finally:
        await manager.unregister(connector_id, connection)
        if reader_task is not None and not reader_task.done():
            reader_task.cancel()
            await asyncio.gather(reader_task, return_exceptions=True)
        if discovery_task is not None:
            discovery_task.cancel()
            await asyncio.gather(discovery_task, return_exceptions=True)
        if flush_task is not None:
            flush_task.cancel()
            await asyncio.gather(flush_task, return_exceptions=True)
        if completion_task is not None:
            completion_task.cancel()
            await asyncio.gather(completion_task, return_exceptions=True)
        if notification_pump is not None:
            await notification_pump.close()
        removed_terminals = await broker.remove_ephemeral_for_connector(
            connector_id,
            connection_id=connection.connection_id,
        )
        if removed_terminals:
            logger.info(
                "removed ephemeral terminals after connector websocket ended "
                "connector_id={} count={}",
                connector_id,
                len(removed_terminals),
            )
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


async def _discover_runtimes(
    runtime_service: DeviceRuntimeService,
    connector_id: str,
    connection: ConnectorConnection,
) -> str | None:
    try:
        return await runtime_service.discover_connection(connector_id, connection)
    except asyncio.CancelledError:
        raise
    except DeviceRuntimeError as exc:
        logger.warning(
            "runtime discovery failed connector_id={} "
            "connection_id={} error_code={} error={}",
            connector_id,
            connection.connection_id,
            exc.code,
            exc.message,
        )
        return None
    except Exception:  # noqa: BLE001 - background task errors must be observed
        logger.exception(
            "runtime discovery crashed connector_id={} connection_id={}",
            connector_id,
            connection.connection_id,
        )
        return None


async def _complete_runtime_discovery(
    runtime_service: DeviceRuntimeService,
    connector_id: str,
    connection: ConnectorConnection,
    *,
    reason: str,
) -> None:
    try:
        await runtime_service.publish_discovery(connector_id, reason)
    except asyncio.CancelledError:
        raise
    except DeviceRuntimeError as exc:
        logger.warning(
            "runtime discovery publication failed connector_id={} "
            "connection_id={} error_code={} error={}",
            connector_id,
            connection.connection_id,
            exc.code,
            exc.message,
        )
    except Exception:  # noqa: BLE001 - background task errors must be observed
        logger.exception(
            "runtime discovery publication crashed connector_id={} connection_id={}",
            connector_id,
            connection.connection_id,
        )

    try:
        await runtime_service.reconcile_active(
            connector_id,
            expected_connection_id=connection.connection_id,
            connection=connection,
        )
    except asyncio.CancelledError:
        raise
    except DeviceRuntimeError as exc:
        logger.warning(
            "runtime reconciliation failed connector_id={} "
            "connection_id={} error_code={} error={}",
            connector_id,
            connection.connection_id,
            exc.code,
            exc.message,
        )
    except Exception:  # noqa: BLE001 - background task errors must be observed
        logger.exception(
            "runtime reconciliation crashed connector_id={} connection_id={}",
            connector_id,
            connection.connection_id,
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

    if term.relay_mode == "attach":
        try:
            await websocket.app.state.store.get_connector(term.connector_id)
        except KeyError:
            await websocket.close(code=1008, reason="connector not found")
            return
    await websocket.accept()
    await websocket.send_json(
        {
            "type": "start",
            "mode": term.relay_mode,
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
            "persistent": term.persistent,
        }
    )
    if await broker.attach_connector(terminal_id, token, websocket) is None:
        await websocket.close(code=1008, reason="invalid terminal relay token")
        return
    hub = (
        websocket.app.state.terminal_stream_hub if term.relay_mode == "attach" else None
    )
    try:
        while True:
            message = await websocket.receive_json()
            if not await broker.owns_connector_socket(terminal_id, websocket):
                break
            mtype = message.get("type")
            if term.relay_mode == "attach":
                if mtype == "response":
                    await broker.relay_response(terminal_id, message)
                elif mtype in {"output", "replay", "exit", "error"}:
                    await hub.publish_relay(term.connector_id, terminal_id, message)
                    if mtype == "exit" and message.get("reason") == "closed":
                        await broker.remove(terminal_id)
                        break
                elif mtype == "ready":
                    pid = message.get("pid")
                    await broker.mark_running(
                        terminal_id, pid=pid if isinstance(pid, int) else None
                    )
                continue
            if mtype == "ready":
                pid = message.get("pid")
                await broker.mark_running(
                    terminal_id, pid=pid if isinstance(pid, int) else None
                )
            elif mtype in {"output", "replay"}:
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


async def _read_connector_messages(
    websocket: WebSocket,
    connector_id: str,
    connection: ConnectorConnection,
    manager: ConnectorRpcManager,
    notification_pump: _ConnectorNotificationPump,
) -> None:
    while True:
        message = await websocket.receive_json()
        if not await manager.touch(connector_id, connection):
            return
        message_type = message.get("type")
        if message_type == "response":
            manager.resolve_response(connector_id, message)
        elif message_type == "notification":
            notification_pump.enqueue_message(message)


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
