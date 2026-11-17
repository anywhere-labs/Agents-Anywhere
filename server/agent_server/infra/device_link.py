"""The worker side of each v3 device link: presence and the outbox pump.

After ``POST /api/v3/device/ready`` the worker that took the request becomes the
device's holder: it opens ``Link/attach`` and ``Link/outbox`` and keeps them open.

- Presence is the open ``attach`` stream. The holder writes the shared lease
  ``connector:presence:{deviceId}`` (``{"instanceId": worker, "holderId":
  "<worker>:<nonce>", "connectionId": "lc_…", "ready": true, "transport":
  "mesh"}``), renews it on every heartbeat (every 20 s, TTL 60 s) and deletes
  it by value when the stream ends, so an older holder, of this generation or
  an older one, never deletes a newer one. ``ready`` again with the current
  ``connectionId`` takes the link over. A half-dead ``attach`` (open, but no
  item for ``ATTACH_IDLE_SECONDS``) is closed before the lease can expire, so
  the holder deletes its own lease and reports the device offline.
  ``ConnectorRpcManager.is_online`` sees v3 devices through the same key.
- ``outbox`` items are handed to a handler and acknowledged cumulatively after
  it returns; a handler failure closes the pump so the device resends.
- ``attach`` events are lossy and go to a second handler.
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
    LINK_ROUTES,
    PRESENCE_LEASE_SECONDS,
    Empty,
    LinkAttachItem,
    LinkAttachRequest,
    OutboxAck,
    OutboxItem,
    OutboxOpenRequest,
)
from agent_server.infra.device_mesh import DeviceCallError, DeviceMesh
from agent_server.infra.redis_coordinator import RedisCoordinator

OutboxHandler = Callable[[str, OutboxItem], Awaitable[None]]
EventHandler = Callable[[str, str, dict[str, Any]], Awaitable[None]]
PresenceHandler = Callable[[str, bool], Awaitable[None]]

# How often the holder checks that attach is still alive.
ATTACH_WATCHDOG_SECONDS = 5.0
# A device that sends nothing on attach for this long is treated as gone even if the stream
# looks open (a half-dead link). The lease is renewed with every attach item, so the watchdog
# must fire (idle + one check interval) before the lease expires: the holder then deletes its own
# lease and reports the device offline, instead of other workers seeing it offline first while
# this worker still serves it. 45 s tolerates one missed heartbeat; it is above the device's own
# ``ATTACH_STALL_SECONDS`` (40 s), so a stuck holder is normally noticed by the device first.
ATTACH_IDLE_SECONDS = PRESENCE_LEASE_SECONDS - 3 * ATTACH_WATCHDOG_SECONDS


@dataclass
class HeldLink:
    device_id: str
    connection_id: str
    lease_value: str
    tasks: list[asyncio.Task[None]] = field(default_factory=list)
    last_heartbeat: float = field(default_factory=time.monotonic)
    first_item: asyncio.Event = field(default_factory=asyncio.Event)
    closed: asyncio.Event = field(default_factory=asyncio.Event)
    close_reason: str = ""


class DeviceLinkHub:
    def __init__(
        self,
        mesh: DeviceMesh,
        coordinator: RedisCoordinator,
        *,
        worker_id: str,
        lease_seconds: float = PRESENCE_LEASE_SECONDS,
        idle_seconds: float = ATTACH_IDLE_SECONDS,
        watchdog_seconds: float = ATTACH_WATCHDOG_SECONDS,
    ) -> None:
        if idle_seconds + watchdog_seconds >= lease_seconds:
            raise ValueError("the attach watchdog must fire before the presence lease expires")
        self._mesh = mesh
        self._coordinator = coordinator
        self.worker_id = worker_id
        self._lease_seconds = lease_seconds
        self._idle_seconds = idle_seconds
        self._watchdog_seconds = watchdog_seconds
        self._links: dict[str, HeldLink] = {}
        # Without Redis: ``deviceId -> (connectionId, expires, lease value)``; compared by value like Redis.
        self._local_leases: dict[str, tuple[str, float, str]] = {}
        self.on_outbox: OutboxHandler | None = None
        self.on_event: EventHandler | None = None
        self.on_presence: PresenceHandler | None = None

    # -- leases ---------------------------------------------------------------

    def lease_key(self, device_id: str) -> str:
        return self._coordinator.key("connector", "presence", device_id)

    def _lease_value(self, connection_id: str) -> str:
        # ``holderId`` is unique per hold: one connectionId can be held by two workers in turn
        # (ready is retried after a holder change), and only the current holder may renew or delete.
        return json.dumps(
            {
                "connectionId": connection_id,
                "holderId": f"{self.worker_id}:{secrets.token_urlsafe(8)}",
                "instanceId": self.worker_id,
                "ready": True,
                "transport": "mesh",
            },
            separators=(",", ":"),
            sort_keys=True,
        )

    async def current_connection(self, device_id: str) -> str | None:
        """The ``connectionId`` of the live v3 link, from any worker, or None when offline."""

        held = self._links.get(device_id)
        if held is not None and not held.closed.is_set() and held.first_item.is_set():
            return held.connection_id
        if not self._coordinator.distributed:
            entry = self._local_leases.get(device_id)
            if entry is None or entry[1] < time.monotonic():
                return None
            return entry[0]
        raw = await self._coordinator.client.get(self.lease_key(device_id))
        if not raw:
            return None
        try:
            lease = json.loads(raw)
        except (TypeError, ValueError):
            return None
        if lease.get("transport") != "mesh" or not lease.get("ready"):
            return None
        connection_id = lease.get("connectionId")
        return connection_id if isinstance(connection_id, str) else None

    async def is_online(self, device_id: str) -> bool:
        return await self.current_connection(device_id) is not None

    def local_connection(self, device_id: str) -> str | None:
        held = self._links.get(device_id)
        if held is not None and not held.closed.is_set() and held.first_item.is_set():
            return held.connection_id
        return None

    def held_devices(self) -> list[str]:
        """Devices whose link this worker holds."""

        return list(self._links)

    async def _write_lease(self, held: HeldLink, *, first: bool) -> bool:
        if not self._coordinator.distributed:
            current = self._local_leases.get(held.device_id)
            if not first and (current is None or current[2] != held.lease_value):
                return False
            self._local_leases[held.device_id] = (
                held.connection_id,
                time.monotonic() + self._lease_seconds,
                held.lease_value,
            )
            return True
        key = self.lease_key(held.device_id)
        ttl_ms = int(self._lease_seconds * 1000)
        if first:
            # A new generation replaces whatever lease is there (an older link, or a v2 WS).
            await self._coordinator.client.set(key, held.lease_value, px=ttl_ms)
            return True
        return await self._coordinator.refresh_if_value(key, held.lease_value, ttl_seconds=self._lease_seconds)

    async def _release_lease(self, held: HeldLink) -> bool:
        if not self._coordinator.distributed:
            current = self._local_leases.get(held.device_id)
            if current is not None and current[2] == held.lease_value:
                del self._local_leases[held.device_id]
                return True
            return False
        return await self._coordinator.delete_if_value(self.lease_key(held.device_id), held.lease_value)

    async def _lease_absent(self, device_id: str) -> bool:
        if not self._coordinator.distributed:
            entry = self._local_leases.get(device_id)
            return entry is None or entry[1] < time.monotonic()
        return not await self._coordinator.client.exists(self.lease_key(device_id))

    async def evict(self, device_id: str) -> bool:
        """Delete the device's v3 presence lease whichever worker holds it (credentials revoked, device deleted).

        Every worker sees the device offline at once; the holder's next renewal fails, so it closes
        its streams and reports the device offline. A v2 WebSocket lease is left alone.
        """

        if not self._coordinator.distributed:
            return self._local_leases.pop(device_id, None) is not None
        key = self.lease_key(device_id)
        raw = await self._coordinator.client.get(key)
        if not raw:
            return False
        try:
            lease = json.loads(raw)
        except (TypeError, ValueError):
            return False
        if not isinstance(lease, dict) or lease.get("transport") != "mesh":
            return False
        return await self._coordinator.delete_if_value(key, raw if isinstance(raw, str) else raw.decode())

    # -- holding a link -----------------------------------------------------

    async def hold(self, device_id: str, connection_id: str, *, wait_seconds: float = 10.0) -> None:
        """Open ``attach`` and ``outbox`` for ``connection_id``; returns once the first attach item arrived.

        Raises ``DeviceCallError`` when the device does not answer (not registered, stale generation).
        """

        previous = self._links.get(device_id)
        if previous is not None:
            await self._stop(previous, "replaced")
        held = HeldLink(device_id=device_id, connection_id=connection_id, lease_value=self._lease_value(connection_id))
        self._links[device_id] = held
        held.tasks.append(asyncio.create_task(self._attach_loop(held), name=f"device-attach-{device_id}"))
        try:
            first = asyncio.create_task(held.first_item.wait())
            closed = asyncio.create_task(held.closed.wait())
            _done, pending = await asyncio.wait(
                {first, closed}, timeout=wait_seconds, return_when=asyncio.FIRST_COMPLETED
            )
            for task in pending:
                task.cancel()
            if not held.first_item.is_set():
                reason = held.close_reason or "attach did not answer"
                await self._stop(held, reason)
                raise DeviceCallError("not_delivered", "unavailable", reason, reason="attach_failed")
        except BaseException:
            if self._links.get(device_id) is held:
                await self._stop(held, "hold failed")
            raise
        held.tasks.append(asyncio.create_task(self._outbox_loop(held), name=f"device-outbox-{device_id}"))
        held.tasks.append(asyncio.create_task(self._watchdog(held), name=f"device-watchdog-{device_id}"))

    async def _attach_loop(self, held: HeldLink) -> None:
        stream = self._mesh.stream(
            held.device_id,
            LINK_ROUTES["link.attach"],
            LinkAttachRequest(connectionId=held.connection_id),
            LinkAttachItem,
            connection_id=held.connection_id,
        )
        try:
            async for item in stream:
                held.last_heartbeat = time.monotonic()
                if not held.first_item.is_set():
                    await self._write_lease(held, first=True)
                    held.first_item.set()
                    logger.info(
                        "device link online device_id={} connection_id={} worker={}",
                        held.device_id,
                        held.connection_id,
                        self.worker_id,
                    )
                    await self._notify_presence(held.device_id, True)
                elif not await self._write_lease(held, first=False):
                    held.close_reason = "lease taken by a newer connection or revoked"
                    return
                if item.kind == "event" and item.m and self.on_event is not None:
                    try:
                        await self.on_event(held.device_id, item.m, item.p)
                    except Exception:  # noqa: BLE001 - lossy events never close the link
                        logger.exception("device event handler failed device_id={} m={}", held.device_id, item.m)
            held.close_reason = held.close_reason or "attach ended"
        except DeviceCallError as exc:
            held.close_reason = f"attach failed: {exc.failure} {exc.code} {exc.reason or ''}".strip()
        except asyncio.CancelledError:
            held.close_reason = held.close_reason or "cancelled"
            raise
        finally:
            with contextlib.suppress(Exception):
                await stream.aclose()
            await self._finish(held)

    async def _outbox_loop(self, held: HeldLink) -> None:
        stream = self._mesh.stream(
            held.device_id,
            LINK_ROUTES["link.outbox"],
            OutboxOpenRequest(connectionId=held.connection_id),
            OutboxItem,
            connection_id=held.connection_id,
        )
        try:
            async for item in stream:
                if self.on_outbox is not None:
                    await self.on_outbox(held.device_id, item)
                await self._mesh.unary(
                    held.device_id,
                    LINK_ROUTES["link.ackOutbox"],
                    OutboxAck(oid=item.oid),
                    Empty,
                    connection_id=held.connection_id,
                    timeout=10,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - a failed handler closes the link so the device resends
            logger.warning("device outbox pump stopped device_id={} error={!r}", held.device_id, exc)
            held.close_reason = f"outbox stopped: {exc!r}"
        finally:
            with contextlib.suppress(Exception):
                await stream.aclose()
            # The outbox must flow while the device is online; without it the link is unusable.
            if not held.closed.is_set():
                await self._stop(held, held.close_reason or "outbox ended")

    async def _watchdog(self, held: HeldLink) -> None:
        while not held.closed.is_set():
            await asyncio.sleep(self._watchdog_seconds)
            if time.monotonic() - held.last_heartbeat > self._idle_seconds:
                await self._stop(held, "no heartbeat")
                return

    async def _stop(self, held: HeldLink, reason: str) -> None:
        held.close_reason = held.close_reason or reason
        current = asyncio.current_task()
        for task in held.tasks:
            if task is not current and not task.done():
                task.cancel()
        await asyncio.gather(*(t for t in held.tasks if t is not current), return_exceptions=True)
        await self._finish(held)

    async def _finish(self, held: HeldLink) -> None:
        if held.closed.is_set():
            return
        held.closed.set()
        current = asyncio.current_task()
        for task in held.tasks:
            if task is not current and not task.done():
                task.cancel()
        if self._links.get(held.device_id) is held:
            del self._links[held.device_id]
        released = False
        with contextlib.suppress(Exception):
            released = await self._release_lease(held)
        logger.info(
            "device link closed device_id={} connection_id={} reason={} lease_released={}",
            held.device_id,
            held.connection_id,
            held.close_reason,
            released,
        )
        if not held.first_item.is_set():
            return
        if not released:
            # Revoked (``evict``) or expired while this worker stalled: nobody else holds the device,
            # so this worker still reports it offline. A newer holder's lease means it stays online.
            with contextlib.suppress(Exception):
                released = await self._lease_absent(held.device_id)
        if released:
            await self._notify_presence(held.device_id, False)

    async def _notify_presence(self, device_id: str, online: bool) -> None:
        if self.on_presence is None:
            return
        try:
            await self.on_presence(device_id, online)
        except Exception:  # noqa: BLE001 - presence fan-out is best effort
            logger.exception("device presence handler failed device_id={} online={}", device_id, online)

    async def drop(self, device_id: str, reason: str) -> None:
        """Stop holding ``device_id`` here (credentials revoked, device deleted)."""

        held = self._links.get(device_id)
        if held is not None:
            await self._stop(held, reason)

    async def close(self) -> None:
        for held in list(self._links.values()):
            await self._stop(held, "server shutting down")
