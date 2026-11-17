"""v3 security debt (``05-server.md`` §8): default secrets, pairing codes, terminal tickets."""

from __future__ import annotations

import asyncio
import json

import pytest
from starlette.websockets import WebSocketDisconnect

from agent_server.core import auth
from agent_server.infra.pairing_store import (
    PairingNotClaimable,
    PairingNotFound,
    PairingStore,
)
from agent_server.infra.redis_coordinator import RedisCoordinator


@pytest.mark.parametrize(
    ("secret", "dev", "refused"),
    [
        (None, False, True),
        ("agent-server-dev-secret", False, True),
        ("change-me-before-production", False, True),
        ("short", False, True),
        ("x" * 32, False, False),
        (None, True, False),
        ("agent-server-dev-secret", True, False),
    ],
)
def test_server_refuses_default_secrets_outside_development(monkeypatch, secret, dev, refused) -> None:
    if secret is None:
        monkeypatch.delenv("AGENT_SERVER_SECRET", raising=False)
    else:
        monkeypatch.setenv("AGENT_SERVER_SECRET", secret)
    if dev:
        monkeypatch.setenv("AGENT_SERVER_DEV_MODE", "1")
    else:
        monkeypatch.delenv("AGENT_SERVER_DEV_MODE", raising=False)
    if refused:
        with pytest.raises(SystemExit):
            auth.require_server_secret()
    else:
        auth.require_server_secret()


def test_pairing_keeps_no_plaintext_and_hands_the_token_over_once(monkeypatch) -> None:
    monkeypatch.setenv("AGENT_SERVER_SECRET", "s" * 40)
    now = [1_000_000.0]
    store = PairingStore(RedisCoordinator(), clock=lambda: now[0])

    async def scenario() -> None:
        started = await store.start(server_url="https://aa.example", ttl_seconds=600)
        dump = json.dumps({key: value for key, (value, _exp) in store._local.items()})
        assert started["code"] not in dump and started["pairingId"] not in dump
        assert (await store.poll(started["pairingId"]))["status"] == "pending"

        claim = await store.begin_claim(started["code"])
        await store.finish_claim(claim, connector_id="conn_1", connector_token="secret-token-1", server_url=None)
        dump = json.dumps({key: value for key, (value, _exp) in store._local.items()})
        assert "secret-token-1" not in dump
        # The code is gone the moment it is claimed.
        with pytest.raises(PairingNotFound):
            await store.begin_claim(started["code"])

        polled = await store.poll(started["pairingId"])
        assert polled["config"] == {
            "serverUrl": "https://aa.example",
            "connectorId": "conn_1",
            "connectorToken": "secret-token-1",
        }
        assert (await store.poll(started["pairingId"])) == {"status": "consumed", "expiresAt": polled["expiresAt"]}

        late = await store.start(server_url=None, ttl_seconds=60)
        now[0] += 61
        assert (await store.poll(late["pairingId"]))["status"] == "expired"
        with pytest.raises((PairingNotFound, PairingNotClaimable)):
            await store.begin_claim(late["code"])
        now[0] += 3600
        with pytest.raises(PairingNotFound):
            await store.poll(late["pairingId"])

    asyncio.run(scenario())


def test_terminal_streams_take_one_time_tickets() -> None:
    from conftest import make_test_client

    with make_test_client() as client:
        store = client.app.state.store
        user = client.portal.call(lambda: store.create_user(user_id="user_term", password="password-term"))
        headers = {"Authorization": f"Bearer {auth.create_user_access_token(user.userId)}"}
        device_id = client.post("/connectors", headers=headers, json={"name": "laptop"}).json()["connector"]["id"]

        def ticket() -> str:
            return client.post(
                "/ws-ticket", headers=headers, json={"clientId": "web_term", "scope": {"dashboard": True}}
            ).json()["ticket"]

        def close_code(url: str) -> int:
            try:
                with client.websocket_connect(url) as ws:
                    ws.receive_json()
            except WebSocketDisconnect as exc:
                return exc.code
            raise AssertionError("the socket stayed open")

        path = f"/connectors/{device_id}/terminals/term_1/stream"
        assert close_code(f"{path}?ticket=not-a-ticket") == 4401
        good = ticket()
        # Past authentication (the device is offline, so the stream ends differently).
        assert close_code(f"{path}?ticket={good}") != 4401
        # A ticket works once.
        assert close_code(f"{path}?ticket={good}") == 4401


def test_pairing_through_redis_keeps_no_plaintext(monkeypatch) -> None:
    from fakeredis import FakeServer
    from fakeredis.aioredis import FakeRedis

    monkeypatch.setenv("AGENT_SERVER_SECRET", "r" * 40)
    redis_server = FakeServer()

    def worker() -> PairingStore:
        client = FakeRedis(server=redis_server, decode_responses=True)
        return PairingStore(RedisCoordinator(prefix="test-pairing", client=client))

    async def dump(store: PairingStore) -> str:
        client = store._coordinator.client
        return json.dumps({key: await client.get(key) for key in await client.keys("test-pairing:*")})

    async def scenario() -> None:
        # Start on one worker, claim on another, poll on a third.
        starter, claimer, poller = worker(), worker(), worker()
        started = await starter.start(server_url="https://aa.example", ttl_seconds=600)
        stored = await dump(starter)
        assert started["code"] not in stored and started["pairingId"] not in stored
        assert 0 < await starter._coordinator.client.ttl(starter._code_key(started["code"])) <= 600

        claim = await claimer.begin_claim(started["code"])
        await claimer.finish_claim(claim, connector_id="conn_r", connector_token="redis-token-1", server_url=None)
        assert "redis-token-1" not in await dump(claimer)
        with pytest.raises(PairingNotFound):
            await claimer.begin_claim(started["code"])

        assert (await poller.poll(started["pairingId"]))["config"]["connectorToken"] == "redis-token-1"
        assert (await poller.poll(started["pairingId"]))["status"] == "consumed"
        assert "sealedToken" not in await dump(poller)

    asyncio.run(scenario())
