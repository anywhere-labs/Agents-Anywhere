"""A half-dead ``Link/attach`` (open, no heartbeats) is closed by the holder before its presence
lease can expire, so the holder deletes its own lease and reports the device offline
(dashboard, preview grace period, ``runtime_status``). When the lease is gone anyway (revoked,
expired while the worker stalled), the holder still reports offline; a newer holder's lease
keeps the device online."""

from __future__ import annotations

import asyncio
import time

import pytest
from fakeredis import FakeServer
from fakeredis.aioredis import FakeRedis

from agent_server.core.device_meshcall import (
    LINK_ROUTES,
    PRESENCE_LEASE_SECONDS,
    LinkAttachItem,
)
from agent_server.infra.device_link import (
    ATTACH_IDLE_SECONDS,
    ATTACH_WATCHDOG_SECONDS,
    DeviceLinkHub,
    HeldLink,
)
from agent_server.infra.redis_coordinator import RedisCoordinator

DEVICE = "conn_w1"


class _Mesh:
    """``attach`` sends one heartbeat, then stays open silently until ``end_attach`` is set."""

    def __init__(self) -> None:
        self.end_attach = asyncio.Event()

    def stream(self, device_id, route, request, item_type, *, connection_id, timeout=None):
        if route == LINK_ROUTES["link.attach"]:
            return self._attach()
        return self._silent()

    async def _attach(self):
        yield LinkAttachItem(kind="heartbeat")
        await self.end_attach.wait()

    async def _silent(self):
        await asyncio.Event().wait()
        yield  # pragma: no cover


def _hubs(mesh: _Mesh, distributed: bool, **timing: float) -> tuple[DeviceLinkHub, DeviceLinkHub]:
    """The holder and another worker; without Redis one process is both (leases are per hub)."""

    if not distributed:
        hub = DeviceLinkHub(mesh, RedisCoordinator(), worker_id="w_a", **timing)  # type: ignore[arg-type]
        return hub, hub
    server = FakeServer()
    return tuple(  # type: ignore[return-value]
        DeviceLinkHub(  # type: ignore[arg-type]
            mesh, RedisCoordinator(prefix="t", client=FakeRedis(server=server)), worker_id=worker, **timing
        )
        for worker in ("w_a", "w_b")
    )


def test_default_watchdog_fires_before_the_lease_expires() -> None:
    assert ATTACH_IDLE_SECONDS + ATTACH_WATCHDOG_SECONDS < PRESENCE_LEASE_SECONDS
    with pytest.raises(ValueError):
        DeviceLinkHub(None, RedisCoordinator(), worker_id="w", lease_seconds=60, idle_seconds=60)  # type: ignore[arg-type]


@pytest.mark.parametrize("distributed", [True, False])
def test_half_dead_attach_is_reported_offline_by_the_holder(distributed: bool) -> None:
    async def scenario() -> None:
        mesh = _Mesh()
        hub, other = _hubs(mesh, distributed, lease_seconds=1.0, idle_seconds=0.4, watchdog_seconds=0.1)
        released: list[bool] = []
        release = hub._release_lease

        async def recording_release(held: HeldLink) -> bool:
            result = await release(held)
            released.append(result)
            return result

        hub._release_lease = recording_release  # type: ignore[method-assign]
        presence: list[tuple[bool, float]] = []

        async def on_presence(device_id: str, online: bool) -> None:
            presence.append((online, time.monotonic()))

        hub.on_presence = on_presence
        await hub.hold(DEVICE, "lc_1")
        online_at = time.monotonic()
        assert await other.current_connection(DEVICE) == "lc_1"

        # No heartbeat follows: the watchdog closes the link while the lease is still there.
        for _ in range(100):
            if len(presence) == 2:
                break
            await asyncio.sleep(0.05)
        assert [online for online, _ in presence] == [True, False]
        assert presence[1][1] - online_at < 1.0
        assert released == [True]
        assert await other.current_connection(DEVICE) is None
        assert hub.held_devices() == []
        await hub.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("distributed", [True, False])
def test_holder_reports_offline_when_its_lease_is_already_gone(distributed: bool) -> None:
    async def scenario() -> None:
        mesh = _Mesh()
        hub, other = _hubs(mesh, distributed)
        presence: list[bool] = []

        async def on_presence(device_id: str, online: bool) -> None:
            presence.append(online)

        hub.on_presence = on_presence
        await hub.hold(DEVICE, "lc_1")
        # The lease disappeared (revoked, or expired while this worker stalled).
        assert await other.evict(DEVICE)
        mesh.end_attach.set()
        for _ in range(100):
            if len(presence) == 2:
                break
            await asyncio.sleep(0.02)
        assert presence == [True, False]
        await hub.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("distributed", [True, False])
def test_old_holder_does_not_report_offline_over_a_newer_holders_lease(distributed: bool) -> None:
    async def scenario() -> None:
        mesh = _Mesh()
        hub, newer = _hubs(mesh, distributed)
        presence: list[bool] = []

        async def on_presence(device_id: str, online: bool) -> None:
            presence.append(online)

        hub.on_presence = on_presence
        await hub.hold(DEVICE, "lc_1")
        # The device called ready again on another worker, which took the lease over.
        taken = HeldLink(device_id=DEVICE, connection_id="lc_1", lease_value=newer._lease_value("lc_1"))
        assert await newer._write_lease(taken, first=True)
        mesh.end_attach.set()
        for _ in range(20):
            await asyncio.sleep(0.02)
            if hub.held_devices() == []:
                break
        await asyncio.sleep(0.05)
        assert presence == [True]
        assert await newer.current_connection(DEVICE) == "lc_1"
        await hub.close()

    asyncio.run(scenario())
