"""One connectionId can be held by two workers in turn (``contracts/device-meshcall/1.0``
「持有者更换」): the lease is renewed and deleted by holder, never by connectionId alone."""

from __future__ import annotations

import asyncio

import pytest
from fakeredis import FakeServer
from fakeredis.aioredis import FakeRedis

from agent_server.infra.device_link import DeviceLinkHub, HeldLink
from agent_server.infra.redis_coordinator import RedisCoordinator


def _hub(worker: str, coordinator: RedisCoordinator) -> DeviceLinkHub:
    return DeviceLinkHub(None, coordinator, worker_id=worker)  # type: ignore[arg-type]


def _held(hub: DeviceLinkHub, connection_id: str = "lc_1") -> HeldLink:
    return HeldLink(device_id="conn_1", connection_id=connection_id, lease_value=hub._lease_value(connection_id))


@pytest.mark.parametrize("distributed", [True, False])
def test_an_old_holder_never_renews_or_deletes_the_new_holders_lease(distributed: bool) -> None:
    async def scenario() -> None:
        if distributed:
            server = FakeServer()
            first = RedisCoordinator(prefix="t", client=FakeRedis(server=server))
            second = RedisCoordinator(prefix="t", client=FakeRedis(server=server))
            worker_a, worker_b = _hub("w_a", first), _hub("w_b", second)
        else:
            # One process without Redis: the same hub holds the connection twice in turn.
            worker_a = worker_b = _hub("w_a", RedisCoordinator())
        old, new = _held(worker_a), _held(worker_b)
        assert old.lease_value != new.lease_value

        assert await worker_a._write_lease(old, first=True)
        # The holder died; the device calls ready again with the same connectionId.
        assert await worker_b._write_lease(new, first=True)
        assert not await worker_a._write_lease(old, first=False)
        assert not await worker_a._release_lease(old)
        assert await worker_b.current_connection("conn_1") == "lc_1"
        assert await worker_a.current_connection("conn_1") == "lc_1"

        assert await worker_b._write_lease(new, first=False)
        assert await worker_b._release_lease(new)
        assert await worker_b.current_connection("conn_1") is None

    asyncio.run(scenario())
