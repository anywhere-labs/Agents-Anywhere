from __future__ import annotations

import json
import secrets
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from redis.asyncio import Redis

from aa_control.core.models import AssistantStreamEvent, NormalDeviceSummary, WatchDevicesEvent

PRESENCE_PREFIX = "aa:v3:presence:"
WATCH_CHANNEL_PREFIX = "aa:v3:user:"
RATE_LIMIT_PREFIX = "aa:v3:rl:"
LOCK_PREFIX = "aa:v3:lock:"
PUSH_READY_KEY = "aa:v3:push:ready"
PUSH_DELAYED_KEY = "aa:v3:push:delayed"
PUSH_DEAD_KEY = "aa:v3:push:dead"
USER_ENTITLEMENTS_PREFIX = "aa:v3:entitlements:"

_RELEASE_LOCK_LUA = """
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
else
    return 0
end
"""


class AssistantEventSubscription:
    """Subscribed Redis Pub/Sub handle for one user's cross-device assistant events."""

    def __init__(self, pubsub: Any, channel: str) -> None:
        self._pubsub = pubsub
        self._channel = channel

    async def next_event(self, *, timeout: float = 1.0) -> AssistantStreamEvent | None:
        deadline = time.monotonic() + max(0.0, timeout)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            message = await self._pubsub.get_message(ignore_subscribe_messages=False, timeout=remaining)
            if not message:
                return None
            if message.get("type") != "message":
                continue
            data = message.get("data")
            if isinstance(data, bytes):
                data = data.decode("utf-8")
            if not isinstance(data, str):
                continue
            try:
                parsed = json.loads(data)
                return AssistantStreamEvent.model_validate(parsed)
            except (ValueError, TypeError):
                continue

    async def close(self) -> None:
        await self._pubsub.unsubscribe(self._channel)
        await self._pubsub.aclose()


@dataclass(frozen=True)
class PresenceSnapshot:
    device_id: str
    mode_hint: str
    platform: str
    connector_version: str
    last_seen_at: str
    router_ids: tuple[str, ...]
    summary: NormalDeviceSummary | None
    e2e_public_key_hint: str | None


class RedisControlStore:
    """Single Redis backing store for presence TTL, watch_devices Pub/Sub, rate limiting, and push retries."""

    def __init__(self, client: Redis, *, presence_ttl_seconds: int = 45) -> None:
        self._redis = client
        self._presence_ttl = presence_ttl_seconds

    @property
    def client(self) -> Redis:
        return self._redis

    async def ping(self) -> bool:
        try:
            return bool(await self._redis.ping())
        except Exception:  # noqa: BLE001
            return False

    async def close(self) -> None:
        await self._redis.aclose()

    # ------------------------------------------------------------------
    # Presence (TTL-backed online state)
    # ------------------------------------------------------------------

    async def set_presence(self, snapshot: PresenceSnapshot) -> None:
        payload = {
            "device_id": snapshot.device_id,
            "mode_hint": snapshot.mode_hint,
            "platform": snapshot.platform,
            "connector_version": snapshot.connector_version,
            "last_seen_at": snapshot.last_seen_at,
            "router_ids": list(snapshot.router_ids),
            "summary": (
                snapshot.summary.model_dump()
                if snapshot.mode_hint == "normal" and snapshot.summary is not None
                else None
            ),
            "e2e_public_key_hint": snapshot.e2e_public_key_hint if snapshot.mode_hint == "encrypted" else None,
        }
        await self._redis.set(
            f"{PRESENCE_PREFIX}{snapshot.device_id}",
            json.dumps(payload),
            ex=self._presence_ttl,
        )

    async def clear_presence(self, device_id: str) -> None:
        await self._redis.delete(f"{PRESENCE_PREFIX}{device_id}")

    async def get_presence(self, device_id: str) -> PresenceSnapshot | None:
        raw = await self._redis.get(f"{PRESENCE_PREFIX}{device_id}")
        if raw is None:
            return None
        return _decode_presence(raw)

    async def get_presences(self, device_ids: list[str]) -> dict[str, PresenceSnapshot]:
        if not device_ids:
            return {}
        keys = [f"{PRESENCE_PREFIX}{did}" for did in device_ids]
        values = await self._redis.mget(keys)
        result: dict[str, PresenceSnapshot] = {}
        for did, raw in zip(device_ids, values, strict=True):
            if raw is not None:
                snap = _decode_presence(raw)
                if snap is not None:
                    result[did] = snap
        return result

    # ------------------------------------------------------------------
    # Multi-instance watch_devices Pub/Sub
    # ------------------------------------------------------------------

    @staticmethod
    def _user_channel(user_id: str) -> str:
        return f"{WATCH_CHANNEL_PREFIX}{user_id}:devices"

    async def publish_device_event(self, user_id: str, event: WatchDevicesEvent) -> None:
        await self._redis.publish(
            self._user_channel(user_id),
            json.dumps(event.to_contract_dict()),
        )

    async def subscribe_device_events(self, user_id: str) -> AsyncIterator[WatchDevicesEvent]:
        pubsub = self._redis.pubsub()
        channel = self._user_channel(user_id)
        await pubsub.subscribe(channel)
        try:
            async for message in pubsub.listen():
                if message.get("type") != "message":
                    continue
                data = message.get("data")
                if isinstance(data, bytes):
                    data = data.decode("utf-8")
                if not isinstance(data, str):
                    continue
                parsed = json.loads(data)
                yield WatchDevicesEvent.model_validate(parsed)
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.aclose()

    # ------------------------------------------------------------------
    # Fixed-window rate limiting
    # ------------------------------------------------------------------

    async def check_rate_limit(self, *, bucket: str, limit: int, window_seconds: int = 60) -> bool:
        """Return True if within limit, False if exhausted."""
        window = int(time.time()) // window_seconds
        key = f"{RATE_LIMIT_PREFIX}{bucket}:{window}"
        count = int(await self._redis.incr(key))
        if count == 1:
            await self._redis.expire(key, window_seconds + 5)
        return count <= limit

    # ------------------------------------------------------------------
    # Push notification queue & delayed retry ZSET
    # ------------------------------------------------------------------

    async def enqueue_push_job(self, job: dict[str, Any]) -> None:
        await self._redis.rpush(PUSH_READY_KEY, json.dumps(job))

    async def pop_push_job(self, *, timeout: float = 0.0) -> dict[str, Any] | None:
        if timeout > 0:
            res = await self._redis.blpop(PUSH_READY_KEY, timeout=timeout)
            raw = res[1] if res else None
        else:
            raw = await self._redis.lpop(PUSH_READY_KEY)
        if raw is None:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        return json.loads(raw)

    async def schedule_push_retry(self, job: dict[str, Any], *, deliver_at_unix: float) -> None:
        await self._redis.zadd(PUSH_DELAYED_KEY, {json.dumps(job): deliver_at_unix})

    async def promote_due_push_retries(self, *, now_unix: float | None = None) -> int:
        now = now_unix if now_unix is not None else time.time()
        due = await self._redis.zrangebyscore(PUSH_DELAYED_KEY, min="-inf", max=now)
        promoted = 0
        for item in due:
            removed = await self._redis.zrem(PUSH_DELAYED_KEY, item)
            if removed:
                raw = item.decode("utf-8") if isinstance(item, bytes) else str(item)
                await self._redis.rpush(PUSH_READY_KEY, raw)
                promoted += 1
        return promoted

    async def record_dead_push_job(self, job: dict[str, Any]) -> None:
        await self._redis.rpush(PUSH_DEAD_KEY, json.dumps(job))

    async def push_queue_lengths(self) -> dict[str, int]:
        return {
            "ready": int(await self._redis.llen(PUSH_READY_KEY)),
            "delayed": int(await self._redis.zcard(PUSH_DELAYED_KEY)),
            "dead": int(await self._redis.llen(PUSH_DEAD_KEY)),
        }

    # ------------------------------------------------------------------
    # Cached OIDC entitlement snapshots (for Connector-initiated calls)
    # ------------------------------------------------------------------

    async def set_user_entitlements(
        self,
        user_id: str,
        entitlements: dict[str, Any],
        *,
        ttl_seconds: int = 86_400,
    ) -> None:
        if not entitlements:
            return
        await self._redis.set(
            f"{USER_ENTITLEMENTS_PREFIX}{user_id}",
            json.dumps(entitlements),
            ex=max(60, ttl_seconds),
        )

    async def get_user_entitlements(self, user_id: str) -> dict[str, Any] | None:
        raw = await self._redis.get(f"{USER_ENTITLEMENTS_PREFIX}{user_id}")
        if raw is None:
            return None
        try:
            text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
            data = json.loads(text)
            return data if isinstance(data, dict) else None
        except (ValueError, TypeError):
            return None

    # ------------------------------------------------------------------
    # Multi-instance assistant cross-device Pub/Sub & distributed locks
    # ------------------------------------------------------------------

    @staticmethod
    def _assistant_channel(user_id: str) -> str:
        return f"{WATCH_CHANNEL_PREFIX}{user_id}:assistant"

    async def publish_assistant_event(self, user_id: str, event: AssistantStreamEvent) -> None:
        await self._redis.publish(
            self._assistant_channel(user_id),
            json.dumps(event.model_dump(), ensure_ascii=False),
        )

    @asynccontextmanager
    async def open_assistant_events(self, user_id: str) -> AsyncIterator[AssistantEventSubscription]:
        pubsub = self._redis.pubsub()
        channel = self._assistant_channel(user_id)
        await pubsub.subscribe(channel)
        sub = AssistantEventSubscription(pubsub, channel)
        try:
            yield sub
        finally:
            await sub.close()

    async def subscribe_assistant_events(self, user_id: str) -> AsyncIterator[AssistantStreamEvent]:
        async with self.open_assistant_events(user_id) as sub:
            while True:
                event = await sub.next_event(timeout=1.0)
                if event is not None:
                    yield event

    async def acquire_lock(self, name: str, *, ttl_seconds: int = 30) -> str | None:
        token = secrets.token_urlsafe(16)
        acquired = await self._redis.set(
            f"{LOCK_PREFIX}{name}",
            token,
            nx=True,
            ex=max(1, ttl_seconds),
        )
        return token if acquired else None

    async def release_lock(self, name: str, token: str) -> None:
        await self._redis.eval(_RELEASE_LOCK_LUA, 1, f"{LOCK_PREFIX}{name}", token)


def _decode_presence(raw: Any) -> PresenceSnapshot | None:
    try:
        text = raw.decode("utf-8") if isinstance(raw, bytes) else str(raw)
        data = json.loads(text)
    except (ValueError, TypeError):
        return None
    summary_raw = data.get("summary")
    mode_hint = str(data.get("mode_hint") or "normal")
    summary = (
        NormalDeviceSummary.model_validate(summary_raw)
        if mode_hint == "normal" and isinstance(summary_raw, dict)
        else None
    )
    return PresenceSnapshot(
        device_id=str(data["device_id"]),
        mode_hint=mode_hint,
        platform=str(data["platform"]),
        connector_version=str(data["connector_version"]),
        last_seen_at=str(data["last_seen_at"]),
        router_ids=tuple(str(r) for r in (data.get("router_ids") or [])),
        summary=summary,
        e2e_public_key_hint=data.get("e2e_public_key_hint") if mode_hint == "encrypted" else None,
    )
