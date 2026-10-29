from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager
from dataclasses import replace
from types import SimpleNamespace

import pytest
from fakeredis import FakeAsyncRedis

from agent_server.infra import connector_mesh_routes as routes_module
from agent_server.infra.connector_mesh_routes import (
    MAX_GENERATION,
    MeshRoute,
    MeshRoutes,
    MeshStateError,
)
from agent_server.infra.redis_coordinator import RedisCoordinator


class RouteCase:
    def __init__(self, mode):
        self.client = FakeAsyncRedis(decode_responses=True) if mode == "redis" else None
        self.coordinator = RedisCoordinator(client=self.client)
        self.current = {"device": "base"}
        async def is_current(connector, connection):
            return self.current.get(connector) == connection
        self.routes = MeshRoutes(self.coordinator, is_current)

    async def connect(self, connection="base"):
        self.current["device"] = connection
        if self.client is not None:
            await self.client.set(self.coordinator.key("connector", "presence", "device"),
                                  json.dumps({"connectionId": connection, "ready": True}), ex=60)

    async def issue(self, link, connection="base"):
        grant = await self.routes.issue_grant(link, {
            "connectorId": "device", "connectionId": connection, "linkId": link,
            "fingerprint": "fingerprint", "expiresAt": time.time() + 900,
        })
        return MeshRoute("device", connection, link, "router", "worker", grant["generation"], "owner-" + link)

    async def state(self, connection="base"):
        if self.client is not None:
            fields = await self.client.hgetall(self.routes.state_key("device", connection))
            return tuple(int(fields[name]) for name in ("issuedGeneration", "publishedGeneration"))
        state = self.routes._states[("device", connection)]
        return state.issued_generation, state.published_generation

    async def expire_route(self):
        if self.client is not None:
            await self.client.pexpire(self.routes._key("device"), 0)
        else:
            route, _ = self.routes._local["device"]
            self.routes._local["device"] = route, 0

    async def forget_state(self):
        if self.client is not None:
            await self.client.delete(self.routes.state_key("device", "base"))
        else:
            self.routes._states.clear()


@asynccontextmanager
async def route_case(mode):
    case = RouteCase(mode)
    await case.connect()
    try:
        yield case
    finally:
        if case.client is not None:
            await case.client.aclose()


@pytest.fixture(params=["memory", "redis"], ids=["memory", "redis-lua"])
def mode(request):
    return request.param


def test_concurrent_issuance_is_unique_and_connections_have_independent_generations(mode):
    async def exercise():
        async with route_case(mode) as case:
            issued = await asyncio.gather(*(case.issue(f"link-{index}") for index in range(32)))
            assert sorted(route.generation for route in issued) == list(range(1, 33))
            assert await case.state() == (32, 0)
            other = await case.issue("other-link", "other-base")
            assert other.generation == 1 and await case.state("other-base") == (1, 0)
            assert await case.state() == (32, 0)
    asyncio.run(exercise())


def test_older_issued_generation_can_publish_until_a_newer_generation_is_published(mode):
    async def exercise():
        async with route_case(mode) as case:
            first, second = await case.issue("one"), await case.issue("two")
            assert await case.routes.publish(first)
            assert await case.state() == (2, 1)
            assert await case.routes.publish(second)
            assert await case.state() == (2, 2)
            assert await case.routes.get("device") == second
    asyncio.run(exercise())


@pytest.mark.parametrize("cleanup", ["remove", "expire"])
def test_route_disappearance_cannot_roll_back_the_published_generation(mode, cleanup):
    async def exercise():
        async with route_case(mode) as case:
            first, second = await case.issue("one"), await case.issue("two")
            assert await case.routes.publish(second)
            if cleanup == "remove":
                await case.routes.remove(second)
            else:
                await case.expire_route()
            assert await case.routes.get("device") is None
            assert not await case.routes.publish(first)
            assert await case.state() == (2, 2)
            assert await case.routes.publish(second), "same generation may republish an absent route"
    asyncio.run(exercise())


@pytest.mark.parametrize("field", ["link_id", "router_id", "worker_id", "owner_id"])
def test_same_generation_republication_requires_full_matching_ownership(mode, field):
    async def exercise():
        async with route_case(mode) as case:
            original = await case.issue("one")
            assert await case.routes.publish(original)
            assert await case.routes.publish(original), "identical publication must be idempotent"
            assert not await case.routes.publish(replace(original, **{field: "other"}))
            assert await case.routes.get("device") == original
            assert await case.state() == (1, 1)
    asyncio.run(exercise())


def test_old_owner_cannot_renew_remove_or_republish_over_a_new_base_connection(mode):
    async def exercise():
        async with route_case(mode) as case:
            old = await case.issue("old")
            assert await case.routes.publish(old)
            await case.connect("new-base")
            new = await case.issue("new", "new-base")
            assert await case.routes.publish(new)
            assert not await case.routes.publish(old)
            assert not await case.routes.renew(old)
            await case.routes.remove(old)
            assert await case.routes.get("device") == new
            assert await case.state("new-base") == (1, 1)
    asyncio.run(exercise())


def test_publication_never_recreates_missing_state(mode):
    async def exercise():
        async with route_case(mode) as case:
            route = await case.issue("one")
            await case.forget_state()
            assert not await case.routes.publish(route)
            assert await case.routes.get("device") is None
            if case.client is not None:
                assert not await case.client.exists(case.routes.state_key("device", "base"))
            else:
                assert not case.routes._states
    asyncio.run(exercise())


@pytest.mark.parametrize("issued,published", [(None, 0), (1, None), (-1, 0), (1, 2), ("1.5", 0), (True, 0), (MAX_GENERATION + 1, 0)])
def test_corrupt_state_is_rejected_without_issuing_or_publishing(mode, issued, published):
    async def exercise():
        async with route_case(mode) as case:
            route = await case.issue("one")
            if case.client is not None:
                key = case.routes.state_key("device", "base")
                await case.client.delete(key)
                await case.client.hset(key, mapping={name: str(value) for name, value in {
                    "issuedGeneration": issued, "publishedGeneration": published}.items() if value is not None})
                await case.client.expire(key, 60)
                before = await case.client.hgetall(key)
            else:
                state = case.routes._states[("device", "base")]
                state.issued_generation, state.published_generation = issued, published
            assert not await case.routes.publish(route)
            with pytest.raises(MeshStateError):
                await case.issue("other")
            assert await case.routes.get("device") is None
            assert await case.routes.grant("other") is None
            if case.client is not None:
                assert await case.client.hgetall(key) == before
            else:
                assert (state.issued_generation, state.published_generation) == (issued, published)
    asyncio.run(exercise())


@pytest.mark.parametrize("generation", [0, -1, True, 2, MAX_GENERATION + 1])
def test_invalid_or_unissued_generations_do_not_create_routes(mode, generation):
    async def exercise():
        async with route_case(mode) as case:
            route = await case.issue("one")
            assert not await case.routes.publish(replace(route, generation=generation))
            assert await case.routes.get("device") is None
            assert await case.state() == (1, 0)
    asyncio.run(exercise())


def test_memory_expiry_preserves_state_beyond_route_lifetime_and_does_not_shorten_it(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(routes_module, "time", SimpleNamespace(monotonic=lambda: clock[0], time=time.time))
    async def exercise():
        async with route_case("memory") as case:
            first = await case.issue("one")
            state = case.routes._states[("device", "base")]
            state.expires_at = 2000
            assert await case.routes.publish(first)
            assert state.expires_at == 2000
            clock[0] += 61
            assert await case.routes.get("device") is None
            assert await case.state() == (1, 1)
            assert await case.routes.publish(first)
            clock[0] = 2001
            assert not await case.routes.publish(first)
            assert state.expires_at == 2000
    asyncio.run(exercise())
