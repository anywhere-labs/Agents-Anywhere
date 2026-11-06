"""Temporary Mesh grants, connection generations and link locations."""

from __future__ import annotations

import json
import math
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass

from redis.exceptions import ResponseError

from agent_server.infra.connector_control_log import control_log, error_fields
from agent_server.infra.redis_coordinator import RedisCoordinator

ROUTE_TTL_SECONDS = 60
ROUTE_RENEW_SECONDS = 20
GRANT_TTL_SECONDS = 900
STATE_TTL_SECONDS = 900
# Lua compares generations as doubles. Keep both fields exactly representable.
MAX_GENERATION = 2**53 - 1

_STATE_HELPERS = """
local function integer(raw)
  if type(raw) ~= 'string' then return nil end
  if raw ~= '0' and not string.match(raw, '^[1-9]%d*$') then return nil end
  local value = tonumber(raw)
  if not value or value > 9007199254740991 then return nil end
  return value
end
local function read_state(key)
  local kind = redis.call('TYPE', key).ok
  if kind == 'none' then return 0, 0, false end
  if kind ~= 'hash' then return nil end
  if redis.call('PTTL', key) < 0 then return nil end
  local fields = redis.call('HMGET', key, 'issuedGeneration', 'publishedGeneration')
  local issued, published = integer(fields[1]), integer(fields[2])
  if not issued or not published or published > issued then return nil end
  return issued, published, true
end
local function now_ms()
  local clock = redis.call('TIME')
  return tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
end
local function extend_state(key, reference_key, reference_deadline, extension)
  -- PTTLs share Redis's command clock. Compare them directly so even a
  -- millisecond boundary cannot shorten an existing later absolute deadline.
  local remaining = redis.call('PTTL', key)
  local required = redis.call('PTTL', reference_key) + extension
  if remaining < required then
    redis.call('PEXPIREAT', key, reference_deadline + extension)
  end
end
"""

_ISSUE_GRANT = _STATE_HELPERS + """
local issued, published, exists = read_state(KEYS[1])
if not issued or issued >= 9007199254740991 then
  return redis.error_reply('invalid connector mesh state')
end
local grant = cjson.decode(ARGV[1])
if type(grant) ~= 'table' or grant.generation ~= nil or string.sub(ARGV[1], -1) ~= '}' then
  return redis.error_reply('invalid connector mesh grant')
end
local generation = string.format('%.0f', issued + 1)
-- Preserve the Python JSON and its exact integer; cjson rounds large numbers.
local payload = string.sub(ARGV[1], 1, -2) .. ',"generation":' .. generation .. '}'
local now = now_ms()
local grant_deadline = now + tonumber(ARGV[2])
local state_deadline = math.max(grant_deadline, now + tonumber(ARGV[3]))
if not exists then
  redis.call('HSET', KEYS[1], 'issuedGeneration', '0', 'publishedGeneration', '0')
  -- Bound a newly allocated state even if a subsequent grant write fails.
  redis.call('PEXPIREAT', KEYS[1], state_deadline)
end
redis.call('HINCRBY', KEYS[1], 'issuedGeneration', 1)
redis.call('SET', KEYS[2], payload, 'PXAT', grant_deadline)
extend_state(KEYS[1], KEYS[2], grant_deadline, state_deadline - grant_deadline)
return payload
"""

_PUBLISH = _STATE_HELPERS + """
local presence = redis.call('GET', KEYS[1])
if not presence then return -1 end
local owner = cjson.decode(presence)
if owner.connectionId ~= ARGV[1] then return -2 end
if not owner.ready then return -3 end
local issued, published, exists = read_state(KEYS[3])
local generation = integer(ARGV[3])
if not issued then return -4 end
if not exists then return -5 end
if not generation or generation < 1 then return -6 end
if generation > issued then return -7 end
if generation < published then return -8 end
local current = redis.call('GET', KEYS[2])
if current then
  local route = cjson.decode(current)
  if route.connection_id == ARGV[1] then
    if route.generation > tonumber(ARGV[3]) then return -9 end
    if route.generation == tonumber(ARGV[3]) and current ~= ARGV[2] then return -10 end
  end
end
local now = now_ms()
local route_deadline = now + tonumber(ARGV[4]) * 1000
redis.call('SET', KEYS[2], ARGV[2], 'PXAT', route_deadline)
redis.call('HSET', KEYS[3], 'publishedGeneration', ARGV[3])
extend_state(KEYS[3], KEYS[2], route_deadline, tonumber(ARGV[5]) - tonumber(ARGV[4]) * 1000)
return 1
"""


class MeshStateError(RuntimeError):
    pass


@dataclass
class _ConnectionState:
    issued_generation: int
    published_generation: int
    expires_at: float

    def valid(self) -> bool:
        return (type(self.issued_generation) is int and type(self.published_generation) is int
                and 0 <= self.published_generation <= self.issued_generation <= MAX_GENERATION
                and math.isfinite(self.expires_at))


@dataclass(frozen=True)
class MeshRoute:
    connector_id: str
    connection_id: str
    link_id: str
    router_id: str
    worker_id: str
    generation: int
    owner_id: str

    def encoded(self) -> str:
        return json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))

    @classmethod
    def decode(cls, raw: object) -> MeshRoute | None:
        if not isinstance(raw, str):
            return None
        try:
            value = cls(**json.loads(raw))
            if any(not isinstance(item, str) or not item for item in (
                value.connector_id, value.connection_id, value.link_id,
                value.router_id, value.worker_id, value.owner_id,
            )) or type(value.generation) is not int or value.generation < 1:
                return None
            return value
        except (ValueError, TypeError):
            return None


class MeshRoutes:
    """Own temporary registration state; base Connector presence stays separate."""

    def __init__(self, coordinator: RedisCoordinator,
                 is_current: Callable[[str, str], Awaitable[bool]]) -> None:
        self.coordinator = coordinator
        self._is_current = is_current
        self._local: dict[str, tuple[MeshRoute, float]] = {}
        self._states: dict[tuple[str, str], _ConnectionState] = {}
        self.local_grants: dict[str, dict] = {}

    def _key(self, connector_id: str) -> str:
        return self.coordinator.key("connector", "mesh-route", connector_id)

    def state_key(self, connector_id: str, connection_id: str) -> str:
        return self.coordinator.key("connector", "mesh-state", connector_id, connection_id)

    def _grant_key(self, digest: str) -> str:
        return self.coordinator.key("mesh-grant", digest)

    async def issue_grant(self, digest: str, value: dict) -> dict:
        fields = {"connectorId": value["connectorId"], "connectionId": value["connectionId"], "linkId": value["linkId"]}
        try:
            grant = await self._issue_grant(digest, value)
        except Exception as exc:
            control_log("grant.issue_failed", level="WARNING", **fields, **error_fields(exc),
                        outcome="rejected" if isinstance(exc, MeshStateError) else "outcome_unknown")
            raise
        control_log("grant.issued", **fields, generation=grant["generation"], leaseSeconds=GRANT_TTL_SECONDS)
        return grant

    async def _issue_grant(self, digest: str, value: dict) -> dict:
        """Allocate a generation and retain its grant under the same expiry fence."""
        connector_id, connection_id = value["connectorId"], value["connectionId"]
        if self.coordinator.distributed:
            try:
                raw = await self.coordinator.client.eval(
                    _ISSUE_GRANT, 2, self.state_key(connector_id, connection_id), self._grant_key(digest),
                    json.dumps(value), GRANT_TTL_SECONDS * 1000, STATE_TTL_SECONDS * 1000,
                )
            except ResponseError as exc:
                if "invalid connector mesh state" in str(exc):
                    raise MeshStateError("invalid connector mesh state") from exc
                raise
            return json.loads(raw)
        async with self.coordinator.lock(f"connector-mesh-route:{connector_id}"):
            now = time.monotonic()
            self._states = {key: state for key, state in self._states.items() if state.expires_at > now}
            state = self._states.get((connector_id, connection_id))
            if state is None:
                state = _ConnectionState(0, 0, now + STATE_TTL_SECONDS)
            if not state.valid() or state.issued_generation == MAX_GENERATION:
                raise MeshStateError("invalid connector mesh state")
            grant = {**value, "generation": state.issued_generation + 1}
            state.issued_generation += 1
            state.expires_at = max(state.expires_at, now + STATE_TTL_SECONDS, now + GRANT_TTL_SECONDS)
            self._states[(connector_id, connection_id)] = state
            self.local_grants = {key: item for key, item in self.local_grants.items()
                                 if item["expiresAt"] > time.time()}
            self.local_grants[digest] = grant
            return grant

    async def grant(self, digest: str) -> dict | None:
        if self.coordinator.distributed:
            raw = await self.coordinator.client.get(self._grant_key(digest))
            return json.loads(raw) if raw else None
        return self.local_grants.get(digest)

    async def get(self, connector_id: str) -> MeshRoute | None:
        if self.coordinator.distributed:
            return MeshRoute.decode(await self.coordinator.client.get(self._key(connector_id)))
        value = self._local.get(connector_id)
        return value[0] if value and value[1] > time.monotonic() else None

    @staticmethod
    def log_fields(route: MeshRoute) -> dict:
        return {"connectorId": route.connector_id, "connectionId": route.connection_id,
                "linkId": route.link_id, "routerId": route.router_id, "workerId": route.worker_id,
                "generation": route.generation}

    def _publication_result(self, route: MeshRoute, reason: str) -> bool:
        accepted = reason == "published"
        control_log("route.published" if accepted else "route.rejected",
                    level="INFO" if accepted else "WARNING", **self.log_fields(route),
                    reason=reason, outcome="published" if accepted else "rejected")
        return accepted

    async def publish(self, route: MeshRoute) -> bool:
        if type(route.generation) is not int or not 1 <= route.generation <= MAX_GENERATION:
            return self._publication_result(route, "invalid_generation")
        if self.coordinator.distributed:
            try:
                result = await self.coordinator.client.eval(
                    _PUBLISH, 3,
                    self.coordinator.key("connector", "presence", route.connector_id),
                    self._key(route.connector_id), self.state_key(route.connector_id, route.connection_id),
                    route.connection_id, route.encoded(), route.generation, ROUTE_TTL_SECONDS, STATE_TTL_SECONDS * 1000,
                )
            except Exception as exc:
                control_log("route.publish_failed", level="ERROR", **self.log_fields(route), **error_fields(exc))
                raise
            reasons = {1: "published", -1: "presence_missing", -2: "connection_replaced", -3: "presence_not_ready",
                       -4: "state_invalid", -5: "state_missing", -6: "invalid_generation", -7: "generation_not_issued",
                       -8: "generation_superseded", -9: "newer_route_present", -10: "same_generation_owner_conflict"}
            return self._publication_result(route, reasons.get(result, "invalid_publish_result"))
        async with self.coordinator.lock(f"connector-mesh-route:{route.connector_id}"):
            if not await self._is_current(route.connector_id, route.connection_id):
                return self._publication_result(route, "connection_replaced")
            now = time.monotonic()
            state = self._states.get((route.connector_id, route.connection_id))
            if state is None or state.expires_at <= now:
                return self._publication_result(route, "state_missing")
            if not state.valid():
                return self._publication_result(route, "state_invalid")
            if route.generation < state.published_generation:
                return self._publication_result(route, "generation_superseded")
            if route.generation > state.issued_generation:
                return self._publication_result(route, "generation_not_issued")
            current = await self.get(route.connector_id)
            if current and current.connection_id == route.connection_id:
                if current.generation > route.generation:
                    return self._publication_result(route, "newer_route_present")
                if current.generation == route.generation and current != route:
                    return self._publication_result(route, "same_generation_owner_conflict")
            state.published_generation = route.generation
            state.expires_at = max(state.expires_at, now + STATE_TTL_SECONDS)
            self._local[route.connector_id] = (route, now + ROUTE_TTL_SECONDS)
            return self._publication_result(route, "published")

    async def renew(self, route: MeshRoute) -> bool:
        if self.coordinator.distributed:
            renewed = await self.coordinator.refresh_if_value(
                self._key(route.connector_id), route.encoded(), ttl_seconds=ROUTE_TTL_SECONDS,
            )
            if not renewed:
                control_log("route.lease_lost", level="WARNING", **self.log_fields(route), reason="route_changed_or_expired")
            return renewed
        if await self.get(route.connector_id) != route:
            control_log("route.lease_lost", level="WARNING", **self.log_fields(route), reason="route_changed_or_expired")
            return False
        self._local[route.connector_id] = (route, time.monotonic() + ROUTE_TTL_SECONDS)
        return True

    async def remove(self, route: MeshRoute) -> None:
        if self.coordinator.distributed:
            removed = await self.coordinator.delete_if_value(self._key(route.connector_id), route.encoded())
        else:
            removed = await self.get(route.connector_id) == route
            if removed:
                self._local.pop(route.connector_id, None)
        control_log("route.removed" if removed else "route.remove_skipped", level="INFO" if removed else "DEBUG",
                    **self.log_fields(route), reason="matching_link" if removed else "route_changed_or_expired")
