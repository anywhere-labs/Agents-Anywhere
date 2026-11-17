"""On-demand ``Sessions/watch`` streams and their fan-out (§3.6, protocol 1.2).

The device pushes timeline changes only for sessions somebody watches.

- ``session-subs:{sessionId}``: hash ``{workerId: expiryMs}``. Every worker with
  local subscribers (open session WebSockets) writes its own field, renews it
  every 15 s and lets it expire after 45 s; a crashed worker leaves nothing behind.
- ``device-subs:{deviceId}``: the sessions of a device that have, or recently had,
  subscribers. The holder walks this set.
- The worker holding the device link (``DeviceLinkHub``) keeps one
  ``Sessions/watch`` per watched session, writes ``seq_ceiling`` before
  forwarding an item past it, and publishes the events on the session's
  timeline channel; every worker's ``TimelineBroker`` hands them to its sockets.
  Nothing is stored or buffered.
- Whenever a watch (re)opens, subscribers get ``session.catchup_required`` and
  read ``/events`` from their own cursor; that also covers the gap between a
  client's snapshot and the first watched item.
- A worker that gains its first local subscriber publishes on ``device-watch``
  so the holder opens the stream at once instead of on its next sweep.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from loguru import logger

from agent_server.core.device_meshcall import (
    REQUEST_METHODS,
    ChangesEvent,
    SessionWatchRequest,
    next_seq_ceiling,
)
from agent_server.core.protocol import ProtocolEventEnvelope
from agent_server.core.protocol_v1_2 import (
    CATCHUP_REQUIRED_EVENT,
    SessionCatchupRequiredPayload,
)
from agent_server.core.utc import utc_now
from agent_server.infra.device_link import DeviceLinkHub
from agent_server.infra.device_mesh import DeviceCallError, DeviceMesh
from agent_server.infra.redis_coordinator import RedisCoordinator

SUBSCRIPTION_HEARTBEAT_SECONDS = 15.0
SUBSCRIPTION_EXPIRY_SECONDS = 45.0
WATCH_RETRY_SECONDS = (0.5, 1.0, 2.0, 5.0, 10.0)

Publish = Callable[[str, dict[str, Any]], Awaitable[None]]


def _now_ms() -> int:
    return int(time.time() * 1000)


@dataclass
class Watch:
    device_id: str
    session_id: str
    connection_id: str
    task: asyncio.Task[None] | None = None
    ceiling: int = 0
    forwarded: int = 0
    reason: str = "subscription_restored"
    stopped: bool = False


@dataclass
class LocalSubscription:
    device_id: str
    count: int = 0


@dataclass
class _DeviceState:
    watches: dict[str, Watch] = field(default_factory=dict)
    reconnected: bool = False


class SessionWatchHub:
    def __init__(
        self,
        mesh: DeviceMesh,
        link_hub: DeviceLinkHub,
        coordinator: RedisCoordinator,
        store: Any,
        publish: Publish,
        *,
        worker_id: str,
        heartbeat_seconds: float = SUBSCRIPTION_HEARTBEAT_SECONDS,
        expiry_seconds: float = SUBSCRIPTION_EXPIRY_SECONDS,
        enabled: Callable[[], bool] = lambda: True,
    ) -> None:
        self._mesh = mesh
        self._links = link_hub
        self._coordinator = coordinator
        self._store = store
        self._publish = publish
        self.worker_id = worker_id
        self._heartbeat = heartbeat_seconds
        self._expiry = expiry_seconds
        self._enabled = enabled
        self._local: dict[str, LocalSubscription] = {}
        self._devices: dict[str, _DeviceState] = {}
        # Single-process mode: the shared hash and set live here.
        self._mem_subs: dict[str, dict[str, int]] = {}
        self._mem_device_subs: dict[str, set[str]] = {}
        self._tasks: list[asyncio.Task[None]] = []
        self._lock = asyncio.Lock()

    # -- keys -------------------------------------------------------------------

    def _subs_key(self, session_id: str) -> str:
        return self._coordinator.key("session-subs", session_id)

    def _device_key(self, device_id: str) -> str:
        return self._coordinator.key("device-subs", device_id)

    def _wake_channel(self) -> str:
        return self._coordinator.channel("device-watch")

    # -- lifecycle --------------------------------------------------------------

    async def start(self) -> None:
        self._tasks.append(asyncio.create_task(self._heartbeat_loop(), name="session-watch-heartbeat"))
        if self._coordinator.distributed:
            self._tasks.append(asyncio.create_task(self._wake_listener(), name="session-watch-wake"))

    async def close(self) -> None:
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks.clear()
        for device_id in list(self._devices):
            await self._stop_device(device_id)
        if self._coordinator.distributed:
            for session_id in list(self._local):
                with contextlib.suppress(Exception):
                    await self._coordinator.client.hdel(self._subs_key(session_id), self.worker_id)

    # -- subscriber side (any worker with an open session WebSocket) -------------

    async def add_subscriber(self, session_id: str, device_id: str) -> None:
        if not self._enabled():
            return
        local = self._local.setdefault(session_id, LocalSubscription(device_id=device_id))
        local.count += 1
        if local.count > 1:
            return
        await self._write_interest(session_id, device_id)
        await self._wake(device_id, session_id)

    async def remove_subscriber(self, session_id: str) -> None:
        local = self._local.get(session_id)
        if local is None:
            return
        local.count -= 1
        if local.count > 0:
            return
        del self._local[session_id]
        if self._coordinator.distributed:
            with contextlib.suppress(Exception):
                await self._coordinator.client.hdel(self._subs_key(session_id), self.worker_id)
        else:
            self._mem_subs.get(session_id, {}).pop(self.worker_id, None)
        # The holder notices on its next sweep; nothing urgent about stopping a stream.

    async def _write_interest(self, session_id: str, device_id: str) -> None:
        expiry = _now_ms() + int(self._expiry * 1000)
        if not self._coordinator.distributed:
            self._mem_subs.setdefault(session_id, {})[self.worker_id] = expiry
            self._mem_device_subs.setdefault(device_id, set()).add(session_id)
            return
        client = self._coordinator.client
        pipe = client.pipeline(transaction=False)
        pipe.hset(self._subs_key(session_id), self.worker_id, expiry)
        pipe.pexpire(self._subs_key(session_id), int(self._expiry * 2000))
        pipe.sadd(self._device_key(device_id), session_id)
        await pipe.execute()

    async def _wake(self, device_id: str, session_id: str) -> None:
        if not self._coordinator.distributed:
            await self.sweep_device(device_id)
            return
        await self._coordinator.client.publish(
            self._wake_channel(), json.dumps({"deviceId": device_id, "sessionId": session_id})
        )

    async def _wake_listener(self) -> None:
        delay = 1.0
        while True:
            pubsub = None
            try:
                pubsub = self._coordinator.client.pubsub()
                await pubsub.subscribe(self._wake_channel())
                delay = 1.0
                async for message in pubsub.listen():
                    if message.get("type") != "message":
                        continue
                    try:
                        data = json.loads(message.get("data"))
                    except (TypeError, ValueError):
                        continue
                    device_id = data.get("deviceId") if isinstance(data, dict) else None
                    if isinstance(device_id, str) and self._links.local_connection(device_id):
                        await self.sweep_device(device_id)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - the periodic sweep still covers missed wakes
                logger.warning("session watch wake listener lost ({}); retry in {}s", type(exc).__name__, delay)
                await asyncio.sleep(delay)
                delay = min(delay * 2, 30.0)
            finally:
                if pubsub is not None:
                    with contextlib.suppress(Exception):
                        await pubsub.aclose()

    async def _heartbeat_loop(self) -> None:
        while True:
            await asyncio.sleep(self._heartbeat)
            for session_id, local in list(self._local.items()):
                try:
                    await self._write_interest(session_id, local.device_id)
                except Exception:  # noqa: BLE001 - retried on the next beat
                    logger.exception("session interest renewal failed session_id={}", session_id)
            for device_id in list(self._devices):
                await self.sweep_device(device_id)
            for device_id in self._held_devices():
                if device_id not in self._devices:
                    await self.sweep_device(device_id)

    def _held_devices(self) -> list[str]:
        return [device_id for device_id in self._links.held_devices() if self._links.local_connection(device_id)]

    # -- holder side --------------------------------------------------------------

    async def _watched_sessions(self, device_id: str) -> set[str]:
        """Sessions of ``device_id`` with an unexpired subscriber; drops stale entries."""

        now = _now_ms()
        live: set[str] = set()
        if not self._coordinator.distributed:
            for session_id in list(self._mem_device_subs.get(device_id, ())):
                fields = self._mem_subs.get(session_id, {})
                for worker, expiry in list(fields.items()):
                    if expiry < now:
                        del fields[worker]
                if fields:
                    live.add(session_id)
                else:
                    self._mem_device_subs[device_id].discard(session_id)
            return live
        client = self._coordinator.client
        members = await client.smembers(self._device_key(device_id))
        for raw in members:
            session_id = raw.decode() if isinstance(raw, bytes) else str(raw)
            fields = await client.hgetall(self._subs_key(session_id))
            expired = [worker for worker, expiry in fields.items() if int(expiry) < now]
            if expired:
                await client.hdel(self._subs_key(session_id), *expired)
            if len(fields) > len(expired):
                live.add(session_id)
            else:
                await client.srem(self._device_key(device_id), session_id)
        return live

    async def sweep_device(self, device_id: str) -> None:
        """Make this worker's watches for ``device_id`` match the subscribers (holder only)."""

        async with self._lock:
            connection_id = self._links.local_connection(device_id)
            if connection_id is None or not self._enabled():
                await self._stop_device(device_id)
                return
            try:
                wanted = await self._watched_sessions(device_id)
            except Exception:  # noqa: BLE001 - Redis hiccup: keep what is open, retry on the next sweep
                logger.exception("session watch sweep failed device_id={}", device_id)
                return
            state = self._devices.setdefault(device_id, _DeviceState())
            reason = "device_reconnected" if state.reconnected else "subscription_restored"
            state.reconnected = False
            for session_id, watch in list(state.watches.items()):
                if session_id not in wanted or watch.connection_id != connection_id:
                    await self._stop_watch(watch)
                    del state.watches[session_id]
            for session_id in wanted - state.watches.keys():
                watch = Watch(device_id=device_id, session_id=session_id, connection_id=connection_id, reason=reason)
                state.watches[session_id] = watch
                watch.task = asyncio.create_task(self._run_watch(watch), name=f"session-watch-{session_id}")
            if not state.watches:
                self._devices.pop(device_id, None)

    async def on_presence(self, device_id: str, online: bool) -> None:
        """Called on the holder when its link comes up or goes down."""

        if online:
            self._devices.setdefault(device_id, _DeviceState()).reconnected = True
            await self.sweep_device(device_id)
        else:
            async with self._lock:
                await self._stop_device(device_id)

    async def _stop_device(self, device_id: str) -> None:
        state = self._devices.pop(device_id, None)
        if state is None:
            return
        for watch in state.watches.values():
            await self._stop_watch(watch)

    async def _stop_watch(self, watch: Watch) -> None:
        watch.stopped = True
        task = watch.task
        if task is not None and not task.done() and task is not asyncio.current_task():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await task

    async def _run_watch(self, watch: Watch) -> None:
        attempt = 0
        while not watch.stopped:
            try:
                fields = await self._store.session_directory_fields(watch.session_id) or {}
                after_seq = int(fields.get("headSeq") or 0)
                watch.ceiling = int(fields.get("seqCeiling") or 0)
                stream = self._mesh.stream(
                    watch.device_id,
                    REQUEST_METHODS["session.watch"],
                    SessionWatchRequest(sessionId=watch.session_id, afterSeq=after_seq),
                    ChangesEvent,
                    connection_id=watch.connection_id,
                )
                # The device replays from ``afterSeq``; clients fill anything before it from their cursor.
                await self._catchup(watch.session_id, watch.reason)
                async for change in stream:
                    attempt = 0
                    await self._forward(watch, change)
                if watch.stopped:
                    return
                watch.reason = "subscription_restored"
            except asyncio.CancelledError:
                raise
            except DeviceCallError as exc:
                if exc.not_delivered or self._links.local_connection(watch.device_id) != watch.connection_id:
                    # The link is gone; presence handling stops the watch, a reconnect reopens it.
                    logger.info("session watch ended session_id={} reason={}", watch.session_id, exc.reason)
                    return
                logger.warning("session watch failed session_id={} error={}", watch.session_id, exc)
                watch.reason = "subscription_restored"
            except Exception:  # noqa: BLE001 - keep the watch alive; clients recover from their cursor
                logger.exception("session watch error session_id={}", watch.session_id)
                watch.reason = "subscription_restored"
            await asyncio.sleep(WATCH_RETRY_SECONDS[min(attempt, len(WATCH_RETRY_SECONDS) - 1)])
            attempt += 1

    async def _forward(self, watch: Watch, change: ChangesEvent) -> None:
        # The floor handed to a device that lost its database must never be below
        # anything a client has seen, so the ceiling is written before forwarding.
        ceiling = next_seq_ceiling(watch.ceiling, change.toSeq)
        if ceiling is not None:
            watch.ceiling = await self._store.raise_session_seq_ceiling(watch.session_id, ceiling)
        watch.forwarded = max(watch.forwarded, change.toSeq)
        if not change.events:
            return
        await self._publish(
            watch.session_id,
            {
                "sessionId": watch.session_id,
                "nextSeq": change.toSeq,
                "events": [event.model_dump(mode="json") for event in change.events],
            },
        )

    async def _catchup(self, session_id: str, reason: str) -> None:
        event = ProtocolEventEnvelope(
            # Unique per notice: sockets drop repeated event ids, and every catch-up must arrive.
            eventId=f"evt_catchup_{secrets.token_urlsafe(12)}",
            sequence=0,
            cursor="seq:0",
            type=CATCHUP_REQUIRED_EVENT,
            sessionId=session_id,
            emittedAt=utc_now(),
            payload=SessionCatchupRequiredPayload(sessionId=session_id, reason=reason).model_dump(mode="json"),
        )
        await self._publish(session_id, {"sessionId": session_id, "events": [event.model_dump(mode="json")]})

    # -- introspection (tests, diagnostics) ---------------------------------------

    def watched(self, device_id: str) -> set[str]:
        state = self._devices.get(device_id)
        return set(state.watches) if state else set()
