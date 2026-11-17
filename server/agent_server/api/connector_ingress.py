from __future__ import annotations

import asyncio
import hashlib
import os
import time
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from anyio import CancelScope
from fastapi import (
    APIRouter,
    Depends,
    Header,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from loguru import logger

from agent_server.core.auth import (
    DEFAULT_EXPIRES_IN,
    connector_access_token_id,
    create_connector_access_token,
)
from agent_server.core.models import (
    ConnectorAuthResponse,
    ConnectorIngestRequest,
    ConnectorIngestResponse,
)
from agent_server.deps import (
    get_connector_ingest_service,
    get_connector_presence,
    get_e2ee_settings,
    get_store,
    get_timeline_broker,
    model_channel_service_for,
)
from agent_server.infra.connector_presence_registry import (
    ConnectorConnection,
    ConnectorPresenceRegistry,
    DuplicateConnectorConnectionError,
)
from agent_server.infra.repositories.facade import Store
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.connector_ingest import ConnectorIngestService
from agent_server.services.connector_notifications import (
    ConnectorNotificationService,
    NotificationValidationError,
)
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.device_runtimes import (
    DeviceRuntimeService,
)
from agent_server.services.effective_capabilities import (
    ConnectorCapabilityRefresh,
)
from agent_server.services.runtime_ingress import (
    notification_runtime_id,
    runtime_notification_is_allowed,
)
from agent_server.services.usage_events import connector_online_event

router = APIRouter(tags=["connector-ingress"])


DEFAULT_NOTIFICATION_CONCURRENCY = 4


_Notification = tuple[str, dict[str, Any], int]
_CoalescingKey = tuple[str, str]


class _NotificationQueue:
    """FIFO that physically removes superseded snapshots at insertion time.

    Replacements go at the tail, in their arrival position. Removing only the
    old payload while leaving tombstones would still grow with stream length.
    Both admission and session lanes use this queue so bursts cannot retain
    every revision before the dispatcher gets its next turn.
    """

    def __init__(self) -> None:
        self._entries: OrderedDict[
            int, tuple[_CoalescingKey | None, _Notification | None]
        ] = OrderedDict()
        self._latest: dict[_CoalescingKey, int] = {}
        self._sequence = 0
        self._available = asyncio.Event()

    def put_nowait(
        self, notification: _Notification | None, key: _CoalescingKey | None = None,
    ) -> bool:
        replaced = False
        if key is not None:
            previous = self._latest.pop(key, None)
            if previous is not None:
                del self._entries[previous]
                replaced = True
        self._sequence += 1
        self._entries[self._sequence] = (key, notification)
        if key is not None:
            self._latest[key] = self._sequence
        self._available.set()
        return replaced

    def empty(self) -> bool:
        return not self._entries

    def get_nowait(self) -> _Notification | None:
        if not self._entries:
            raise asyncio.QueueEmpty
        _, (key, notification) = self._entries.popitem(last=False)
        if key is not None:
            self._latest.pop(key)
        if not self._entries:
            self._available.clear()
        return notification

    async def get(self) -> _Notification | None:
        while self.empty():
            await self._available.wait()
        return self.get_nowait()


@dataclass(slots=True)
class _NotificationLane:
    queue: _NotificationQueue = field(default_factory=_NotificationQueue)


class _ConnectorNotificationPump:
    """Apply connector notifications with per-session ordering and coalescing.

    Notifications for one session are still applied strictly in arrival order:
    revisions and timeline items for that session must never overtake each
    other. Independent sessions no longer queue behind each other, and
    connector-level notifications (no ``sessionId``) share one lane so their
    relative order is preserved. ``max_concurrency`` bounds how many lanes may
    run at the same time.

    ``timeline.itemUpsert`` carries a complete replacement for one stable item
    ID, so an entry still queued when a newer value for the same item arrives is
    dropped before it costs anything. The existing pending-projection dedup only
    avoids the database write; this drops the whole per-delta cost.
    """

    def __init__(
        self,
        connector_id: str,
        ingest_service: ConnectorIngestService,
        *,
        connection_id: str | None = None,
        max_concurrency: int = DEFAULT_NOTIFICATION_CONCURRENCY,
        is_current: Callable[[], bool] | None = None,
        unconfigured_runtimes: set[str] | None = None,
    ) -> None:
        self._connector_id = connector_id
        self._connection_id = connection_id
        self._ingest_service = ingest_service
        self._is_current = is_current
        self._runtime_generations: dict[str | None, int] = {}
        self._blocked_runtimes = set(unconfigured_runtimes or ())
        self._inflight_tasks: dict[asyncio.Task[None], str | None] = {}
        self._accepting = True
        self._abort_task: asyncio.Task[None] | None = None
        self._lane_tasks: set[asyncio.Task[None]] = set()
        self._queue = _NotificationQueue()
        self._task: asyncio.Task[None] | None = None
        self._lanes: dict[str, _NotificationLane] = {}
        self._active_lanes: set[str] = set()
        self._lane_guard = asyncio.Lock()
        self._slots = asyncio.Semaphore(max(1, max_concurrency))
        self._pending = 0
        self._idle = asyncio.Event()
        self._idle.set()
        self.coalesced = 0
        self.obsolete = 0

    def _runtime_current(self, method: str, params: dict[str, Any], generation: int) -> bool:
        return (
            generation == self._runtime_generations.get(notification_runtime_id(params), 0)
            and runtime_notification_is_allowed(method, params, self._blocked_runtimes)
        )

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
        if not self._accepting:
            return
        if self._task is not None and self._task.done():
            self._task.result()
            raise RuntimeError("connector notification pump stopped unexpectedly")
        method = message.get("method")
        params = message.get("params") or {}
        if isinstance(method, str) and isinstance(params, dict):
            if not runtime_notification_is_allowed(method, params, self._blocked_runtimes):
                self.obsolete += 1
                return
            generation = self._runtime_generations.get(notification_runtime_id(params), 0)
            self._mark_pending(1)
            self._enqueue(self._queue, (method, params, generation))

    async def close(self) -> None:
        self._accepting = False
        if self._abort_task is not None:
            await asyncio.shield(self._abort_task)
            return
        if self._task is None:
            return
        if not self._task.done():
            self._queue.put_nowait(None)
            await asyncio.gather(self._task, return_exceptions=True)
            await self._idle.wait()
            return
        await asyncio.gather(self._task, return_exceptions=True)
        await self._idle.wait()

    async def abort(self) -> None:
        """Stop admission and await every old handler before releasing ownership."""
        self._accepting = False
        if self._abort_task is None:
            self._abort_task = asyncio.create_task(self._abort())
        await asyncio.shield(self._abort_task)

    async def _abort(self) -> None:
        dropped = self._pending
        tasks = list(self._lane_tasks)
        if self._task is not None:
            tasks.append(self._task)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        # A task cancelled before its first step never enters its finally block.
        for lane in self._lanes.values():
            while not lane.queue.empty():
                lane.queue.get_nowait()
                self._mark_pending(-1)
        self._lanes.clear()
        self._active_lanes.clear()
        while not self._queue.empty():
            if self._queue.get_nowait() is not None:
                self._mark_pending(-1)
        await self._idle.wait()
        if dropped:
            logger.info(
                "discarded obsolete connector notifications connector_id={} count={}",
                self._connector_id, dropped,
            )

    async def flush(self) -> None:
        task = self.task
        if task.done():
            await task
            raise RuntimeError("connector notification pump stopped unexpectedly")
        await self._idle.wait()
        if task.done():
            await task
            raise RuntimeError("connector notification pump stopped unexpectedly")

    def _mark_pending(self, delta: int) -> None:
        self._pending += delta
        if self._pending <= 0:
            self._pending = 0
            self._idle.set()
        else:
            self._idle.clear()

    async def _run(self) -> None:
        try:
            while True:
                notification = await self._queue.get()
                if notification is None:
                    return
                method, params, generation = notification
                await self._dispatch(method, params, generation)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception(
                "connector notification worker failed connector_id={}",
                self._connector_id,
            )
            raise

    def _enqueue(self, queue: _NotificationQueue, notification: _Notification) -> None:
        method, params, _ = notification
        item_key = self._item_key(method, params)
        key = (self._lane_key(params), item_key) if item_key is not None else None
        if queue.put_nowait(notification, key):
            self.coalesced += 1
            self._mark_pending(-1)

    async def _dispatch(self, method: str, params: dict[str, Any], generation: int) -> None:
        key = self._lane_key(params)
        async with self._lane_guard:
            lane = self._lanes.get(key)
            if lane is None:
                lane = _NotificationLane()
                self._lanes[key] = lane
            self._enqueue(lane.queue, (method, params, generation))
            if key not in self._active_lanes:
                self._active_lanes.add(key)
                task = asyncio.create_task(
                    self._run_lane(key, lane),
                    name=f"connector-notifications-{self._connector_id}-{key}",
                )
                self._lane_tasks.add(task)
                task.add_done_callback(self._lane_tasks.discard)

    async def _run_lane(self, key: str, lane: _NotificationLane) -> None:
        try:
            while True:
                try:
                    notification = lane.queue.get_nowait()
                    assert notification is not None  # Only admission receives a close sentinel.
                    method, params, generation = notification
                except asyncio.QueueEmpty:
                    async with self._lane_guard:
                        if lane.queue.empty():
                            self._active_lanes.discard(key)
                            self._lanes.pop(key, None)
                            return
                        continue
                try:
                    async with self._slots:
                        if not self._runtime_current(method, params, generation):
                            self.obsolete += 1
                            continue
                        if self._is_current is None or self._is_current():
                            task = asyncio.create_task(self._handle(method, params))
                            self._inflight_tasks[task] = notification_runtime_id(params)
                            try:
                                await task
                            except asyncio.CancelledError:
                                if asyncio.current_task().cancelling():
                                    raise
                                self.obsolete += 1
                            finally:
                                self._inflight_tasks.pop(task, None)
                finally:
                    # Includes cancellation while waiting for a concurrency slot.
                    self._mark_pending(-1)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - one lane must not stop the pump
            logger.exception(
                "connector notification lane failed connector_id={} lane={}",
                self._connector_id,
                key,
            )
        finally:
            async with self._lane_guard:
                self._active_lanes.discard(key)
                self._lanes.pop(key, None)
                dropped = 0
                while not lane.queue.empty():
                    lane.queue.get_nowait()
                    dropped += 1
            if dropped:
                self._mark_pending(-dropped)

    async def _handle(self, method: str, params: dict[str, Any]) -> None:
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
            return
        elapsed_ms = (time.monotonic() - started_at) * 1000
        if elapsed_ms >= 100:
            logger.info(
                "connector notification handled connector_id={} method={} session_id={} elapsed_ms={:.1f}",
                self._connector_id,
                method,
                params.get("sessionId"),
                elapsed_ms,
            )
        elif method == "timeline.itemUpsert":
            # High-frequency streaming path: only useful while debugging.
            logger.debug(
                "connector notification handled connector_id={} method={} session_id={} elapsed_ms={:.1f}",
                self._connector_id,
                method,
                params.get("sessionId"),
                elapsed_ms,
            )

    @staticmethod
    def _lane_key(params: dict[str, Any]) -> str:
        session_id = params.get("sessionId")
        if isinstance(session_id, str) and session_id:
            return f"session:{session_id}"
        return "connector"

    @staticmethod
    def _item_key(method: str, params: dict[str, Any]) -> str | None:
        """Return the stable item ID a full-replacement notification targets."""

        if method != "timeline.itemUpsert":
            return None
        item = params.get("item")
        if not isinstance(item, dict):
            return None
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id:
            return None
        return item_id


@router.post("/connector/auth", response_model=ConnectorAuthResponse)
async def connector_auth(
    authorization: str = Header(..., alias="Authorization"),
    db: Store = Depends(get_store),
) -> ConnectorAuthResponse:
    connector_id, token = _parse_connector_authorization(authorization)
    if not await db.verify_connector_token(connector_id, token):
        raise HTTPException(status_code=401, detail="invalid connector credential")
    return ConnectorAuthResponse(
        accessToken=create_connector_access_token(
            connector_id,
            credential_hash=hashlib.sha256(token.encode("utf-8")).hexdigest(),
        ),
        expiresIn=DEFAULT_EXPIRES_IN,
    )


@router.post("/connector/ingest", response_model=ConnectorIngestResponse)
async def connector_ingest(
    payload: ConnectorIngestRequest,
    authorization: str = Header(..., alias="Authorization"),
    db: Store = Depends(get_store),
    ingest_service: ConnectorIngestService = Depends(get_connector_ingest_service),
) -> ConnectorIngestResponse:
    connector_id = _access_token_connector_id(authorization)
    async with db.connector_lifecycle(connector_id):
        await _require_active_connector(authorization, db)
        try:
            return await ingest_service.ingest(connector_id=connector_id, payload=payload)
        except NotificationValidationError as exc:
            raise HTTPException(
                status_code=400,
                detail={"code": exc.code, "message": exc.message},
            ) from exc


@router.websocket("/connector/ws")
async def connector_ws(
    websocket: WebSocket,
    db: Store = Depends(get_store),
    manager: ConnectorPresenceRegistry = Depends(get_connector_presence),
    timeline_broker: TimelineBroker = Depends(get_timeline_broker),
) -> None:
    """A v2 Connector's socket: its presence and the metadata it pushes (D4).

    The Server never sends it a request: terminals, files, shell and instance management need Agents Anywhere
    upgraded on that device.
    """

    auth_header = websocket.headers.get("authorization")
    runtime_service: DeviceRuntimeService = websocket.app.state.device_runtime_service
    try:
        connector_id = _access_token_connector_id(auth_header)
        async with db.connector_lifecycle(connector_id):
            await _require_active_connector(auth_header, db)
            connection = await manager.register(connector_id, websocket, ready=False)
            ingest_service = ConnectorIngestService(
                db, ConnectorNotificationService(
                    db,
                    usage_recorder=websocket.app.state.usage_recorder,
                    e2ee_settings=lambda: get_e2ee_settings(websocket),
                ),
                timeline_broker, runtime_service, manager,
                websocket.app.state.session_runtime_state_cache,
                websocket.app.state.capability_refresh,
                runtime_event=model_channel_service_for(websocket.app.state).runtime_event,
            )
            notification_pump = _ConnectorNotificationPump(
                connector_id, ingest_service,
                connection_id=connection.connection_id,
                is_current=lambda: manager.accepts_notifications(connection),
                unconfigured_runtimes=await db.get_unconfigured_runtime_ids(connector_id),
                max_concurrency=int(os.environ.get("AGENT_SERVER_NOTIFICATION_CONCURRENCY", "4")),
            )
            notification_pump.start()
            connection.abort_notifications = notification_pump.abort
            connection.drain_notifications = notification_pump.close
            try:
                device_os = _connector_device_os(websocket.headers.get("x-device-os"))
                if not await db.record_connector_connection(
                    connector_id,
                    device_os=device_os,
                ):
                    await websocket.close(code=1008, reason="connector was revoked")
                    return
                await db.record_connector_activity(connector_id)
                await websocket.accept()
                if not await manager.mark_ready(connection):
                    await websocket.close(code=4409, reason="connector ownership was lost")
                    return
            finally:
                if not connection.ready:
                    await manager.unregister(connector_id, connection)
    except HTTPException:
        await websocket.close(code=1008, reason="invalid connector access token")
        return
    except DuplicateConnectorConnectionError:
        await websocket.close(code=4409, reason="connector id already connected")
        logger.warning("rejected duplicate connector websocket: {}", connector_id)
        return

    reader_task: asyncio.Task[None] | None = None
    presence_task: asyncio.Task[None] | None = None
    try:
        # Usage statistics: the device is online once the socket is ready. This
        # runs inside the main try so a disconnect during the write still
        # reaches the cleanup below.
        await websocket.app.state.usage_recorder.record(
            connector_online_event(
                connector_id=connector_id,
                user_id=None,
                device_os=device_os,
            )
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
        presence_task = asyncio.create_task(
            _publish_connection_presence(db, manager, timeline_broker, connector_id, websocket.app.state.capability_refresh),
            name=f"connector-presence-{connection.connection_id}",
        )
        done, _pending = await asyncio.wait(
            {reader_task, notification_pump.task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if reader_task in done:
            await reader_task
            return
        if notification_pump.task in done:
            if connection.invalidated:
                return
            await notification_pump.task
            raise RuntimeError("connector notification worker stopped unexpectedly")
    except WebSocketDisconnect:
        logger.info("connector disconnected: {}", connector_id)
    finally:
        with CancelScope(shield=True):
            for task in (reader_task, presence_task):
                if task is not None and not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
            try:
                if await manager.begin_drain(connection):
                    # The lease remains reserved until accepted work has settled.
                    # Explicit invalidation can interrupt this drain at any time.
                    async with asyncio.timeout(10):
                        await notification_pump.close()
            except TimeoutError:
                logger.warning("connector notification drain timed out connector_id={}", connector_id)
            finally:
                await manager.unregister(connector_id, connection)
            websocket.app.state.capability_refresh.request(connector_id)
            await publish_dashboard_changed(
                db,
                timeline_broker,
                connector_id=connector_id,
                reason="connector.presence",
            )


async def _publish_connection_presence(db, manager, broker, connector_id: str, refresh: ConnectorCapabilityRefresh) -> None:
    try:
        await publish_dashboard_changed(
            db, broker, connector_id=connector_id, reason="connector.online",
        )
        refresh.request(connector_id)
    except Exception:  # noqa: BLE001 - background publication must not stop the reader
        logger.exception("connector presence publication failed connector_id={}", connector_id)


def _connector_device_os(value: str | None) -> str | None:
    normalized = (value or "").strip().lower()
    return normalized if normalized in {"macos", "windows", "linux"} else None


async def _read_connector_messages(
    websocket: WebSocket,
    connector_id: str,
    connection: ConnectorConnection,
    manager: ConnectorPresenceRegistry,
    notification_pump: _ConnectorNotificationPump,
) -> None:
    while True:
        message = await websocket.receive_json()
        if not await manager.touch(connector_id, connection):
            return
        if message.get("type") == "notification":
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


async def _require_active_connector(authorization: str | None, db: Store) -> str:
    prefix = "Bearer "
    if authorization is None or not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="invalid connector access token")
    connector_id = await db.authenticate_connector_access(authorization[len(prefix) :])
    if connector_id is None:
        raise HTTPException(status_code=401, detail="invalid connector access token")
    return connector_id


def _access_token_connector_id(authorization: str | None) -> str:
    """Only select the admission lock; authentication still happens inside it."""
    if authorization is not None and authorization.startswith("Bearer "):
        connector_id = connector_access_token_id(authorization[len("Bearer "):])
        if connector_id is not None:
            return connector_id
    raise HTTPException(status_code=401, detail="invalid connector access token")
