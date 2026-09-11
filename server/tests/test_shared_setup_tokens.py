from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta

import pytest
from agent_server.core.setup_token import SetupToken
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.services.setup_tokens import SetupTokenService
from fakeredis import FakeServer
from fakeredis.aioredis import FakeRedis
from httpx import ASGITransport, AsyncClient
from redis.exceptions import ConnectionError
from test_auth import make_client


def coordinator(server: FakeServer) -> RedisCoordinator:
    return RedisCoordinator(client=FakeRedis(server=server, decode_responses=True))


def test_four_workers_share_one_token_and_do_not_extend_its_lifetime():
    async def run():
        server = FakeServer()
        workers = [
            SetupTokenService(
                SetupToken(log_writer=lambda _: None), coordinator(server)
            )
            for _ in range(4)
        ]
        snapshots = await asyncio.gather(*(worker.snapshot() for worker in workers))
        assert len(set(snapshots)) == 1
        value, expires_at = snapshots[0]
        assert all(await asyncio.gather(*(worker.verify(value) for worker in workers)))
        assert await workers[3].snapshot() == (value, expires_at)
        assert await workers[2].verify("wrong-token") is False
        await workers[1].consume()
        assert await workers[0].verify(value) is False
        replacements = await asyncio.gather(*(worker.snapshot() for worker in workers))
        assert len(set(replacements)) == 1
        assert replacements[0][0] != value

    asyncio.run(run())


def test_expired_shared_token_is_replaced_and_local_stale_value_is_not_republished():
    async def run():
        redis = coordinator(FakeServer())
        local = SetupToken(log_writer=lambda _: None)
        service = SetupTokenService(local, redis)
        old, _ = await service.snapshot()
        await redis.client.set(
            redis.key("setup-token"),
            json.dumps(
                {
                    "value": old,
                    "expiresAt": (datetime.now(UTC) - timedelta(seconds=1)).isoformat(),
                }
            ),
        )
        assert await service.verify(old) is False
        assert local.peek() != old
        assert 0 < await redis.client.pttl(redis.key("setup-token")) <= 900_000

    asyncio.run(run())


def test_redis_outage_does_not_fall_back_to_accepting_local_bootstrap_token():
    async def run():
        server = FakeServer()
        local = SetupToken(log_writer=lambda _: None)
        service = SetupTokenService(local, coordinator(server))
        value, _ = await service.snapshot()
        server.connected = False
        with pytest.raises(ConnectionError):
            await service.verify(value)
        # Cleanup is called only after the admin transaction commits; an
        # outage here must not turn successful registration into an error.
        await service.consume()
        assert local.peek() is None

    asyncio.run(run())


def test_bootstrap_config_on_one_worker_and_registration_on_another(tmp_path):
    apps = [make_client(tmp_path).app for _ in range(2)]

    async def run():
        server = FakeServer()
        for app in apps:
            app.state.redis = coordinator(server)
        async with (
            AsyncClient(
                transport=ASGITransport(app=apps[0]), base_url="http://test"
            ) as first,
            AsyncClient(
                transport=ASGITransport(app=apps[1]), base_url="http://test"
            ) as second,
        ):
            configs = await asyncio.gather(
                first.get("/api/v2/auth/config"), second.get("/api/v2/auth/config")
            )
            assert all(config.status_code == 200 for config in configs)
            assert (
                configs[0].json()["setupTokenExpiresAt"]
                == configs[1].json()["setupTokenExpiresAt"]
            )
            value = apps[0].state.setup_token.peek()
            assert value == apps[1].state.setup_token.peek()
            assert value not in configs[0].text
            response = await second.post(
                "/api/v2/auth/register",
                json={
                    "email": "admin@example.test",
                    "displayName": "Admin",
                    "password": "test-password",
                    "setupToken": value,
                },
            )
            assert response.status_code == 200, response.text
            assert response.json()["role"] == "admin"
            assert (await first.get("/api/v2/auth/config")).json()[
                "needsBootstrap"
            ] is False
            retry = await first.post(
                "/api/v2/auth/register",
                json={
                    "email": "other@example.test",
                    "displayName": "Other",
                    "password": "test-password",
                    "setupToken": value,
                },
            )
            assert retry.status_code == 403

    asyncio.run(run())
