from __future__ import annotations

import asyncio
import os
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

import fakeredis.aioredis
import httpx
import pytest
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncEngine

from aa_control.app import create_app
from aa_control.core.config import ControlSettings
from aa_control.core.errors import DeviceOfflineError
from aa_control.core.models import RouterTokenEntry
from aa_control.core.utc import unix_ms_to_iso, utc_now_iso
from aa_control.infra.db.engine import create_engine
from aa_control.infra.db.schema import metadata
from aa_control.infra.push import PushDeliveryEnvelope
from aa_control.infra.router_pool import OpenedRouterTunnel


@dataclass
class RecordedCall:
    device_id: str
    service: str
    method: str
    payload: dict[str, Any]
    metadata: dict[str, str] = field(default_factory=dict)


class FakeRouterPool:
    """In-memory RouterPoolPort for deterministic unit & integration tests."""

    def __init__(self, router_ids: tuple[str, ...] = ("router-1",)) -> None:
        self._router_ids = router_ids
        self.calls: list[RecordedCall] = []
        self.opened_tunnels: list[dict[str, Any]] = []
        self.revoked_tunnels: list[str] = []
        self.session_handlers: dict[str, Any] = {}
        self.admin_handlers: dict[str, Any] = {}
        self.offline_devices: set[str] = set()

    @property
    def router_ids(self) -> tuple[str, ...]:
        return self._router_ids

    async def health(self) -> bool:
        return True

    async def issue_client_tokens(
        self,
        *,
        principal: str,
        ttl_seconds: int,
    ) -> list[RouterTokenEntry]:
        exp = unix_ms_to_iso(int((time.time() + ttl_seconds) * 1000))
        return [
            RouterTokenEntry(
                router_id=rid,
                router_url=f"wss://{rid}.example.test",
                token=f"mt_client_{rid}_{secrets.token_hex(8)}",
                token_id=f"tok_{secrets.token_hex(6)}",
                expires_at=exp,
            )
            for rid in self._router_ids
        ]

    async def issue_device_tokens(
        self,
        *,
        device_id: str,
        principal: str,
        ttl_seconds: int,
    ) -> list[RouterTokenEntry]:
        exp = unix_ms_to_iso(int((time.time() + ttl_seconds) * 1000))
        return [
            RouterTokenEntry(
                router_id=rid,
                router_url=f"wss://{rid}.example.test",
                token=f"mt_dev_{rid}_{device_id}_{secrets.token_hex(6)}",
                token_id=f"dtok_{secrets.token_hex(6)}",
                expires_at=exp,
            )
            for rid in self._router_ids
        ]

    async def open_tunnel(
        self,
        *,
        device_id: str,
        principal: str,
        ttl_seconds: int,
        e2e_key: str | None = None,
        preferred_router_ids: tuple[str, ...] = (),
    ) -> OpenedRouterTunnel:
        if device_id in self.offline_devices:
            raise DeviceOfflineError(f"device {device_id} offline on router")
        rid = (preferred_router_ids or self._router_ids)[0]
        tid = f"tun_{secrets.token_hex(8)}"
        prefix = "mtun_e2e." if e2e_key else "mtun_"
        cred = f"{prefix}{secrets.token_urlsafe(18)}"
        exp = unix_ms_to_iso(int((time.time() + ttl_seconds) * 1000))
        self.opened_tunnels.append(
            {
                "router_id": rid,
                "device_id": device_id,
                "principal": principal,
                "e2e_key": e2e_key,
                "tunnel_id": tid,
            }
        )
        return OpenedRouterTunnel(
            router_id=rid,
            router_url=f"wss://{rid}.example.test",
            tunnel_id=tid,
            credential=cred,
            expires_at=exp,
        )

    async def revoke_tunnel(self, tunnel_id: str) -> bool:
        self.revoked_tunnels.append(tunnel_id)
        return True

    async def call_device_admin(
        self,
        *,
        device_id: str,
        method: str,
        payload: dict[str, Any],
        timeout: float = 3.0,
    ) -> dict[str, Any]:
        self.calls.append(
            RecordedCall(device_id=device_id, service="aa.v3.DeviceAdmin", method=method, payload=dict(payload))
        )
        handler = self.admin_handlers.get(device_id)
        if handler is not None:
            res = handler(method, payload)
            return await res if asyncio.iscoroutine(res) else res
        if method == "ping":
            return {"ok": True, "server_time": utc_now_iso()}
        return {"ok": True}

    async def call_device_sessions(
        self,
        *,
        device_id: str,
        method: str,
        payload: dict[str, Any],
        on_behalf_of: str,
        via: str,
        mcp_client: str | None = None,
        timeout: float = 3.0,
    ) -> dict[str, Any]:
        meta = {"aa-on-behalf-of": on_behalf_of, "aa-via": via}
        if mcp_client:
            meta["aa-mcp-client"] = mcp_client
        self.calls.append(
            RecordedCall(
                device_id=device_id,
                service="aa.v3.Sessions",
                method=method,
                payload=dict(payload),
                metadata=meta,
            )
        )
        handler = self.session_handlers.get(device_id)
        if handler is not None:
            res = handler(method, payload, meta)
            return await res if asyncio.iscoroutine(res) else res
        return {"sessions": [], "projects": []}


class RecordingPushProvider:
    def __init__(self, *, fail_times: int = 0) -> None:
        self.sent: list[PushDeliveryEnvelope] = []
        self._fail_remaining = fail_times

    async def send(self, envelope: PushDeliveryEnvelope) -> None:
        if self._fail_remaining > 0:
            self._fail_remaining -= 1
            raise RuntimeError("simulated APNs/FCM transient failure")
        self.sent.append(envelope)


@pytest.fixture
async def db_engine() -> AsyncEngine:
    test_db_url = os.environ.get("AA_CONTROL_TEST_DB_URL")
    if test_db_url:
        assert "test" in test_db_url.lower(), "AA_CONTROL_TEST_DB_URL must point to a disposable test database"
        engine = create_engine(test_db_url)
        async with engine.begin() as conn:
            await conn.run_sync(metadata.drop_all)
            await conn.run_sync(metadata.create_all)
        try:
            yield engine
        finally:
            await engine.dispose()
    else:
        engine = create_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(metadata.create_all)
        try:
            yield engine
        finally:
            await engine.dispose()


@pytest.fixture
async def redis_client() -> Redis:
    test_redis_url = os.environ.get("AA_CONTROL_TEST_REDIS_URL")
    if test_redis_url:
        client = Redis.from_url(test_redis_url, decode_responses=False)
        await client.flushdb()
        try:
            yield client
        finally:
            await client.flushdb()
            await client.aclose()
    else:
        server = fakeredis.FakeServer()
        client = fakeredis.aioredis.FakeRedis(server=server)
        try:
            yield client
        finally:
            await client.aclose()


@pytest.fixture
def router_pool() -> FakeRouterPool:
    return FakeRouterPool()


@pytest.fixture
def push_provider() -> RecordingPushProvider:
    return RecordingPushProvider()


@pytest.fixture
def settings() -> ControlSettings:
    return ControlSettings(
        database_url="sqlite+aiosqlite:///:memory:",
        redis_url="redis://localhost:6379/0",
        secret_key="test-control-secret-key",
        public_origin="https://aa.example.test",
        password_iterations=1_000,
        fanout_timeout_seconds=0.5,
        push_max_attempts=3,
        push_base_backoff_seconds=1.0,
    )


@pytest.fixture
def app(
    settings: ControlSettings,
    db_engine: AsyncEngine,
    redis_client: Redis,
    router_pool: FakeRouterPool,
    push_provider: RecordingPushProvider,
):
    return create_app(
        settings=settings,
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        start_push_worker=False,
    )


@pytest.fixture
async def http_client(app):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://aa.example.test") as client:
        yield client
