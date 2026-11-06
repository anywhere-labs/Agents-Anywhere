"""Check Mesh state invariants with real Redis and the no-Redis implementation.

Run from server via python -m tools.probe_connector_mesh_state, with --redis-url
pointing to disposable Redis. Only a random
namespace is touched. Without Redis, check the single-process path alone.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import secrets
import time
from contextlib import ExitStack
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from redis.exceptions import ConnectionError as RedisConnectionError

from agent_server.infra import connector_mesh as mesh_module
from agent_server.infra import connector_mesh_routes as routes_module
from agent_server.infra.connector_mesh import ConnectorMesh
from agent_server.infra.connector_mesh_routes import MAX_GENERATION, MeshStateError
from agent_server.infra.redis_coordinator import RedisCoordinator


async def probe_mode(redis_url: str | None) -> list[dict]:
    prefix = "aa441-state-probe-" + secrets.token_hex(8)
    coordinators = [RedisCoordinator(redis_url, prefix=prefix) for _ in range(3 if redis_url else 1)]
    current = {}

    async def is_current(connector_id, connection_id):
        return current.get(connector_id) == connection_id

    meshes = [ConnectorMesh(SimpleNamespace(instance_id=f"worker-{index}", is_connection_id_current=is_current), c)
              for index, c in enumerate(coordinators)]
    for index, mesh in enumerate(meshes):
        mesh.router_id = f"router-{index}"
    mesh, redis = meshes[0], coordinators[0]
    results = []

    def passed(scenario):
        results.append({"mode": "Redis" if redis_url else "local", "scenario": scenario, "passed": True})

    async def connection(name, connection_id="cnx-1"):
        connector_id = "connector-" + name
        current[connector_id] = connection_id
        if redis_url:
            await redis.client.set(redis.key("connector", "presence", connector_id),
                                   json.dumps({"instanceId": "base-owner", "connectionId": connection_id,
                                               "ready": True, "meshCapable": True}), ex=60)
        return connector_id, connection_id

    async def issue(identity, issuer=mesh):
        info = await issuer.issue(*identity, "probe-fingerprint")
        assert set(info) == {"protocolVersion", "path", "services", "instanceId", "connectionId", "token", "expiresIn"}
        grant = await mesh.grant(info["token"])
        assert grant is not None and type(grant["generation"]) is int
        assert set(grant) == {"connectorId", "connectionId", "fingerprint", "expiresAt", "linkId", "generation"}
        return info, grant, issuer.route_for(grant)

    async def snapshot(identity):
        if redis_url:
            return await redis.client.hgetall(mesh.routes.state_key(*identity))
        state = mesh.routes._states.get(identity)
        if state is None or state.expires_at <= time.monotonic():
            return {}
        return {"issuedGeneration": str(state.issued_generation), "publishedGeneration": str(state.published_generation)}

    async def assert_state(identity, issued, published):
        assert await snapshot(identity) == {"issuedGeneration": str(issued), "publishedGeneration": str(published)}

    async def ttl(identity):
        if redis_url:
            return await redis.client.pttl(mesh.routes.state_key(*identity)) / 1000
        return mesh.routes._states[identity].expires_at - time.monotonic()

    async def set_ttl(identity, seconds):
        if redis_url:
            await redis.client.pexpire(mesh.routes.state_key(*identity), round(seconds * 1000))
        else:
            mesh.routes._states[identity].expires_at = time.monotonic() + seconds

    async def corrupt(identity, issued, published):
        if redis_url:
            key = mesh.routes.state_key(*identity)
            await redis.client.delete(key)
            fields = {}
            if issued is not None:
                fields["issuedGeneration"] = issued
            if published is not None:
                fields["publishedGeneration"] = published
            await redis.client.hset(key, mapping=fields)
            await redis.client.pexpire(key, 10_000)
        else:
            state = mesh.routes._states[identity]
            state.issued_generation, state.published_generation = issued, published

    try:
        for coordinator in coordinators:
            await coordinator.start()
        identity = await connection("concurrent")
        issued = await asyncio.gather(*(issue(identity, meshes[index % len(meshes)]) for index in range(64)))
        assert sorted(grant["generation"] for _, grant, _ in issued) == list(range(1, 65))
        await assert_state(identity, 64, 0)
        if redis_url:
            assert await redis.client.type(mesh.routes.state_key(*identity)) == "hash"
            state_deadline = await redis.client.pexpiretime(mesh.routes.state_key(*identity))
            for info, _, _ in issued:
                digest = hashlib.sha256(info["token"].encode()).hexdigest()
                assert state_deadline >= await redis.client.pexpiretime(redis.key("mesh-grant", digest))
        await issue(await connection("independent"))
        await assert_state(("connector-independent", "cnx-1"), 1, 0)
        passed("concurrent issuance, exact two-field Hash and independent connections")

        identity = await connection("ordered")
        _, _, first = await issue(identity)
        _, _, second = await issue(identity, meshes[-1])
        assert await mesh.routes.publish(first), "issued=2 must not prevent generation 1 from publishing"
        await assert_state(identity, 2, 1)
        assert await meshes[-1].routes.publish(second)
        await assert_state(identity, 2, 2)
        await mesh.routes.remove(second)
        assert not await mesh.routes.publish(first), "route deletion must retain the generation fence"
        assert await mesh.routes.publish(second), "the published generation may reattach when the route is empty"
        assert await mesh.routes.publish(second), "identical route publication must be idempotent"
        assert not await mesh.routes.publish(replace(second, owner_id="different-owner"))
        assert not await mesh.routes.publish(replace(second, generation=3))
        assert not await mesh.routes.publish(replace(second, generation=True))
        await mesh.routes.remove(first)
        assert await mesh.routes.get(identity[0]) == second
        assert not await mesh.routes.renew(first)
        await assert_state(identity, 2, 2)
        passed("issued versus published ordering, route deletion, equal-generation ownership and stale cleanup")

        identity = await connection("expiry")
        _, _, first = await issue(identity)
        _, _, second = await issue(identity)
        assert await mesh.routes.publish(second)
        if redis_url:
            await redis.client.pexpire(mesh.routes._key(identity[0]), 1)
            await asyncio.sleep(0.02)
        else:
            mesh.routes._local[identity[0]] = (second, time.monotonic() - 1)
        assert await mesh.routes.get(identity[0]) is None
        assert not await mesh.routes.publish(first)
        await assert_state(identity, 2, 2)
        passed("expired route cannot let a delayed older grant take over")

        identity = await connection("ttl")
        info, _, first = await issue(identity)
        if redis_url:
            digest = hashlib.sha256(info["token"].encode()).hexdigest()
            assert await redis.client.pexpiretime(mesh.routes.state_key(*identity)) >= await redis.client.pexpiretime(
                redis.key("mesh-grant", digest))
        else:
            grant = await mesh.grant(info["token"])
            assert await ttl(identity) >= grant["expiresAt"] - time.time() - 0.01
        await set_ttl(identity, 1000)
        await issue(identity)
        assert await ttl(identity) > 999, "issuance shortened a later state deadline"
        assert await mesh.routes.publish(first)
        assert await ttl(identity) > 999, "publication shortened a later state deadline"
        await set_ttl(identity, 1.5)
        assert not await mesh.routes.publish(replace(first, generation=3))
        assert await mesh.routes.get(identity[0]) == first
        assert await mesh.routes.renew(first)
        await mesh.routes.remove(first)
        assert 0 < await ttl(identity) <= 1.5, "read, renew, delete or failed publish extended the state"
        passed("grant expiry coverage, never shortening state TTL, and no state renewal by route cleanup")

        identity = await connection("missing")
        _, _, first = await issue(identity)
        if redis_url:
            await redis.client.delete(mesh.routes.state_key(*identity))
        else:
            mesh.routes._states.pop(identity)
        assert not await mesh.routes.publish(first)
        assert not await snapshot(identity), "publication recreated missing state"
        passed("publication fails closed when state is missing")

        for index, values in enumerate([(None, 0), (1, None), (-1, 0), (1, 2), ("1.5", 0), (MAX_GENERATION + 1, 0)]):
            identity = await connection(f"corrupt-{index}")
            _, _, first = await issue(identity)
            await corrupt(identity, *values)
            before = await snapshot(identity)
            assert not await mesh.routes.publish(first)
            try:
                await issue(identity)
            except MeshStateError:
                pass
            else:
                raise AssertionError("issuance replaced corrupt state")
            assert await snapshot(identity) == before
            assert await mesh.routes.get(identity[0]) is None
        if redis_url:
            identity = await connection("wrong-type")
            _, _, first = await issue(identity)
            key = mesh.routes.state_key(*identity)
            await redis.client.set(key, "invalid", ex=10)
            assert not await mesh.routes.publish(first)
            try:
                await issue(identity)
            except MeshStateError:
                pass
            else:
                raise AssertionError("issuance overwrote a wrong-type state key")
            assert await redis.client.get(key) == "invalid"
        passed("missing fields, invalid integers, inconsistent watermarks and wrong Redis type are not reset")

        identity = await connection("missing-ttl")
        _, _, first = await issue(identity)
        if redis_url:
            await redis.client.persist(mesh.routes.state_key(*identity))
        else:
            mesh.routes._states[identity].expires_at = float("inf")
        assert not await mesh.routes.publish(first)
        try:
            await issue(identity)
        except MeshStateError:
            pass
        else:
            raise AssertionError("issuance accepted unbounded corrupt state")
        await assert_state(identity, 1, 0)
        passed("state without an expiry is rejected without silently replacing its lifetime")

        identity = await connection("integer-boundary")
        await issue(identity)
        await corrupt(identity, MAX_GENERATION - 1, MAX_GENERATION - 2)
        _, grant, last = await issue(identity)
        assert grant["generation"] == MAX_GENERATION
        assert await mesh.routes.publish(last)
        try:
            await issue(identity)
        except MeshStateError:
            pass
        else:
            raise AssertionError("generation counter overflowed")
        await assert_state(identity, MAX_GENERATION, MAX_GENERATION)
        passed("large generation stays an exact integer; exhaustion never wraps or resets")

        old = await connection("replacement", "old-connection")
        _, _, first = await issue(old)
        assert await mesh.routes.publish(first)
        new = await connection("replacement", "new-connection")
        _, _, second = await issue(new)
        assert await mesh.routes.publish(second)
        assert not await mesh.routes.publish(first)
        await mesh.routes.remove(first)
        assert await mesh.routes.get(new[0]) == second
        await assert_state(old, 1, 1)
        await assert_state(new, 1, 1)
        passed("base connection replacement isolates state and rejects old-owner publication")

        if redis_url:
            identity = await connection("redis-error")
            _, _, first = await issue(identity)
            real_client = redis.client

            class FailingRedis:
                async def eval(self, *args):
                    raise RedisConnectionError("probe Redis failure")

            with patch.object(redis, "_client", FailingRedis()):
                for operation in (lambda: issue(identity), lambda: mesh.routes.publish(first)):
                    try:
                        await operation()
                    except RedisConnectionError:
                        pass
                    else:
                        raise AssertionError("Redis failure was hidden")
                assert not mesh.routes._states and not mesh.routes.local_grants
            assert redis.client is real_client
            await assert_state(identity, 1, 0)
            assert await mesh.routes.get(identity[0]) is None
            passed("Redis errors do not issue grants, publish routes or fall back to local state")

            identity = await connection("lost-signing-response")

            class LostSigningResponse:
                async def eval(self, *args):
                    await real_client.eval(*args)
                    raise RedisConnectionError("probe lost signing acknowledgement")

            with patch.object(redis, "_client", LostSigningResponse()):
                try:
                    await issue(identity)
                except RedisConnectionError:
                    pass
                else:
                    raise AssertionError("signing response loss was hidden")
            await assert_state(identity, 1, 0)
            _, grant, _ = await issue(identity)
            assert grant["generation"] == 2
            await assert_state(identity, 2, 0)
            passed("lost Lua signing response keeps the committed generation; next bootstrap does not reuse it")

        # Short lifetimes exist only in this probe, never as deployment knobs.
        with ExitStack() as stack:
            stack.enter_context(patch.object(mesh_module, "GRANT_TTL_SECONDS", 1))
            stack.enter_context(patch.multiple(routes_module, GRANT_TTL_SECONDS=1, STATE_TTL_SECONDS=3, ROUTE_TTL_SECONDS=1))
            identity = await connection("short-ttl")
            info, _, first = await issue(identity)
            assert await mesh.routes.publish(first)
            await asyncio.sleep(1.1)
            assert await mesh.grant(info["token"]) is None
            await assert_state(identity, 1, 1)
            assert await mesh.routes.get(identity[0]) is None
            await asyncio.sleep(2.1)
            assert not await mesh.routes.publish(first)
            assert not await snapshot(identity)
        passed("short-TTL probe: grant and route expire before state; publication cannot resurrect expired state")

        if redis_url:
            identity = await connection("legacy-key-isolation")
            legacy_keys = [redis.key(family, *identity) for family in ("mesh-generation", "mesh-published")]
            for key in legacy_keys:
                await redis.client.set(key, "500", ex=900)
            _, grant, route = await issue(identity)
            assert grant["generation"] == 1
            assert await mesh.routes.publish(route)
            assert await redis.client.mget(legacy_keys) == ["500", "500"]
            await redis.client.delete(*legacy_keys)
            for legacy in ("mesh-generation", "mesh-published"):
                assert not [key async for key in redis.client.scan_iter(redis.key(legacy, "*"))]
            passed("new state ignores old counters, leaves legacy keys unchanged and creates none")
        return results
    finally:
        for mesh in meshes:
            await mesh.close()
        if redis_url:
            keys = [key async for key in redis.client.scan_iter(prefix + ":*")]
            if keys:
                await redis.client.delete(*keys)
        for coordinator in coordinators:
            await coordinator.close()


async def main(args):
    results = await probe_mode(None)
    if args.redis_url:
        results.extend(await probe_mode(args.redis_url))
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    (output / "results.json").write_text(json.dumps(results, indent=2))
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--redis-url")
    parser.add_argument("--output", default="../.local-dev/mesh-state-probe")
    asyncio.run(main(parser.parse_args()))
