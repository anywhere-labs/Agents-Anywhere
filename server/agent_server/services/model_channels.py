"""Model channels: the user's current channel and transactional runtime switches.

Each runtime uses one channel at a time. Moving a runtime to the channel it
should use is a transaction kept in ``runtime_channel_switches``:

    pending → waiting_online (if offline) → switching: preparing →
    activating → verifying → applied
                                    ↘ restoring → restored | failed

Before anything is written, the runtime's whole configuration, activation and
assignment are sealed into a snapshot; a failed write, start or verification
puts that snapshot back. Steps are saved as they happen, so a Server that dies
mid-switch resumes from the row (``resume``).

Nothing polls. A waiting runtime is marked in Redis (or memory without Redis)
and is picked up when something happens to it: a task ends, its device comes
back, a request reaches it, or the user looks at or changes the channel.
Channel changes never wait for running tasks; restarting interrupts them.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from loguru import logger
from redis.exceptions import RedisError

from agent_server.core.device_runtime import DeviceRuntimeView, public_runtime_view
from agent_server.core.model_channel import (
    ACTIVATING,
    APPLIED,
    FAILED,
    IN_FLIGHT,
    NATIVE,
    NEEDS_RETRY,
    PENDING,
    PREPARING,
    RESTORED,
    RESTORING,
    SWITCHING,
    TOKENS,
    UNFINISHED,
    UNSUPPORTED,
    VERIFYING,
    WAITING_ONLINE,
    managed_channel_runtime_id,
    profile_channel,
    switch_state,
)
from agent_server.core.model_config import (
    MANAGED_BY,
    ModelUnavailableError,
    Offer,
    TooManyModelsError,
    apply_patch,
    effective_offers,
    match_offer,
    plan_mode,
    revert_patch,
    written_digest,
)
from agent_server.core.model_connection import connection_digest
from agent_server.core.protocol import ProtocolModelCatalog
from agent_server.core.utc import utc_now
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.secret_box import SecretBox, SecretBoxUnavailableError
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.services.device_runtimes import (
    DeviceRuntimeError,
    DeviceRuntimeInvalidConfigError,
    DeviceRuntimeOfflineError,
    DeviceRuntimeService,
)
from agent_server.services.model_config import (
    ModelConfigConflictError,
    ModelConfigError,
    ModelConfigNotFoundError,
    ModelConfigService,
)

# How long a step may hold a switch before another worker may take it over.
LEASE = timedelta(seconds=60)
# Requests reaching a runtime wait this long for a switch before giving up.
ADMISSION_WAIT_SECONDS = 90.0
ADMISSION_TTL = timedelta(minutes=2)
# A closing switch lets requests already admitted start their task, this long at most.
ADMISSION_DRAIN_SECONDS = 30.0
ADMISSION_DRAIN_INTERVAL_SECONDS = 0.25
VERIFY_TIMEOUT_SECONDS = 120.0
RESTARTING_STATUSES = {"starting", "running"}
# The device dropped mid-switch: the row waits for it to come back and verifies then.
OFFLINE = "offline"
# Marks a pending runtime whose channel stays but must be written again (a new key).
REWRITE = "rewrite"
# Planning errors that say the channel cannot work on this runtime at all.
UNSUPPORTED_CODES = {"model_unavailable", "too_many_models", "models_required", "format_unsupported", "mode_unsupported"}


class ModelChannelError(ModelConfigError):
    pass


class ModelChannelRepository(Protocol):
    async def channel_discovery_gated(self, connector_id: str) -> bool: ...
    async def channel_connector_owner(self, connector_id: str) -> str | None: ...
    async def bump_channel_connection(self, user_id: str, channel: str) -> None: ...
    async def plan_channel_switch(self, connector_id: str, runtime_id: str, values: dict[str, Any]) -> None: ...
    async def request_channel_retry(self, connector_id: str, runtime_id: str) -> None: ...
    def channel_transaction(self, user_id: str) -> Any: ...
    def channel_execution(self, connector_id: str, runtime_id: str, owner: str, epoch: int) -> Any: ...
    async def assert_channel_execution(self) -> None: ...
    async def refresh_channel_targets(self, user_id: str) -> None: ...
    async def get_channel_sync(self, connector_id: str, runtime_id: str) -> dict[str, Any] | None: ...
    async def list_channel_sync(self, user_id: str) -> list[dict[str, Any]]: ...
    async def record_channel_observation(self, connector_id: str, runtime_id: str, **values: Any) -> None: ...
    async def channel_retry(self, connector_id: str, runtime_id: str, error: str | None, *, automatic: bool = False) -> None: ...
    async def enqueue_channel_sync(self, user_id: str, connector_id: str) -> None: ...
    async def claim_channel_execution(self, connector_id: str, runtime_id: str, owner: str) -> int | None: ...
    async def renew_channel_execution(self, connector_id: str, runtime_id: str, owner: str, epoch: int, *, release: bool = False) -> bool: ...

    async def list_channel_runtime_users(self) -> list[str]: ...
    async def create_channel_switch_if_missing(self, connector_id: str, runtime_id: str, *, user_id: str) -> bool: ...
    async def get_channel_selection(self, user_id: str) -> dict[str, Any] | None: ...
    async def save_channel_selection(self, user_id: str, channel: str | None = None) -> dict[str, Any]: ...
    async def list_channel_overrides(self, *, user_id: str) -> list[dict[str, Any]]: ...
    async def set_channel_override(
        self, connector_id: str, runtime_id: str, channel: str | None, *, confirm_native_global: bool = False,
    ) -> None: ...
    async def get_channel_switch(self, connector_id: str, runtime_id: str) -> dict[str, Any] | None: ...
    async def list_channel_switches(self, *, user_id: str) -> list[dict[str, Any]]: ...
    async def list_unfinished_channel_switches(self, *, states: tuple[str, ...]) -> list[dict[str, Any]]: ...
    async def save_channel_switch(self, connector_id: str, runtime_id: str, values: dict[str, Any]) -> dict[str, Any]: ...
    async def next_switch_revision(self, connector_id: str, runtime_id: str) -> int: ...
    async def admit_runtime_request(
        self, connector_id: str, runtime_id: str, *, gate_runtime_ids: list[str],
        token: str, expires_at: str, now: str,
    ) -> bool: ...
    async def release_runtime_request(self, token: str) -> None: ...
    async def close_runtime_for_switch(
        self, connector_id: str, runtime_id: str, values: dict[str, Any], *,
        count_runtime_ids: list[str], now: str,
    ) -> int: ...
    async def count_runtime_admissions(self, connector_id: str, runtime_ids: list[str], *, now: str) -> int: ...
    async def runtime_closed_for_switch(self, connector_id: str, runtime_ids: list[str], *, now: str) -> bool: ...
    async def list_user_device_runtimes(self, *, user_id: str) -> list[dict[str, Any]]: ...
    async def list_model_profiles(self, *, user_id: str) -> list[dict[str, Any]]: ...
    async def list_runtime_assignments(self, *, user_id: str) -> list[dict[str, Any]]: ...
    async def get_runtime_assignment(self, connector_id: str, runtime_id: str) -> dict[str, Any] | None: ...
    async def save_runtime_assignment(self, row: dict[str, Any]) -> None: ...
    async def delete_runtime_assignment(self, connector_id: str, runtime_id: str) -> None: ...
    async def set_device_runtime_managed_by(self, connector_id: str, runtime_id: str, managed_by: str | None) -> None: ...
    async def find_managed_runtime_id(self, connector_id: str, runtime_type: str, managed_by: str, *, legacy_only: bool = False) -> str | None: ...
    async def get_tokens_link(self, user_id: str) -> dict[str, Any] | None: ...
    async def get_setting(self, key: str, default: str | None = None) -> str | None: ...
    async def list_running_sessions_for_connector_agent(
        self, *, connector_id: str, runtime_id: str, user_id: str | None = None,
    ) -> list[Any]: ...


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


class ChannelWakeIndex:
    """Runtimes waiting for an event, by device; Redis when shared, memory otherwise."""

    def __init__(self, coordinator: RedisCoordinator | None) -> None:
        self._coordinator = coordinator if coordinator is not None and coordinator.distributed else None
        self._local: dict[str, dict[str, str]] = {}

    def _key(self, connector_id: str) -> str:
        assert self._coordinator is not None
        return self._coordinator.key("channel-wait", connector_id)

    async def mark(self, connector_id: str, runtime_id: str, user_id: str, generation: int = 0) -> None:
        previous = self._local.get(connector_id, {}).get(runtime_id)
        previous_generation = json.loads(previous).get("generation", 0) if previous and previous.startswith("{") else 0
        if previous_generation <= generation:
            self._local.setdefault(connector_id, {})[runtime_id] = json.dumps({"user": user_id, "generation": generation})
        if self._coordinator is not None:
            try:
                await self._coordinator.client.eval("""
local old = redis.call('HGET', KEYS[1], ARGV[1])
local decoded = old and pcall(cjson.decode, old)
local version = 0
if decoded then version = cjson.decode(old).generation or 0 end
if version <= tonumber(ARGV[3]) then
 redis.call('HSET', KEYS[1], ARGV[1], cjson.encode({user=ARGV[2], generation=tonumber(ARGV[3])}))
end
""", 1, self._key(connector_id), runtime_id, user_id, generation)
            except RedisError:
                logger.warning("channel wake cache unavailable connector_id={}", connector_id)

    async def clear(self, connector_id: str, runtime_id: str, generation: int | None = None) -> None:
        previous = self._local.get(connector_id, {}).get(runtime_id)
        previous_generation = json.loads(previous).get("generation", 0) if previous and previous.startswith("{") else 0
        if generation is not None and previous_generation <= generation:
            self._local.get(connector_id, {}).pop(runtime_id, None)
        if self._coordinator is not None:
            try:
                await self._coordinator.client.eval("""
local old = redis.call('HGET', KEYS[1], ARGV[1])
if not old then return 0 end
local ok, value = pcall(cjson.decode, old)
if ok and (tonumber(ARGV[2]) < (value.generation or 0)) then return 0 end
return redis.call('HDEL', KEYS[1], ARGV[1])
""", 1, self._key(connector_id), runtime_id, generation if generation is not None else -1)
            except RedisError:
                logger.warning("channel wake clear unavailable connector_id={}", connector_id)

    async def waiting(self, connector_id: str, runtime_id: str) -> tuple[str, str] | None:
        """The (runtime, user) waiting on events of ``runtime_id``: itself or the runtime it serves."""
        if self._coordinator is not None:
            try:
                value = await self._coordinator.client.hget(self._key(connector_id), runtime_id)
            except RedisError:
                value = self._local.get(connector_id, {}).get(runtime_id)
        else:
            value = self._local.get(connector_id, {}).get(runtime_id)
        return _parse_wait(runtime_id, value) if value else None

    async def on_connector_raw(self, connector_id: str) -> dict[str, tuple[str, str]]:
        """Every marked runtime of a device and the (runtime, user) it wakes."""
        if self._coordinator is not None:
            try:
                raw = dict(await self._coordinator.client.hgetall(self._key(connector_id)) or {})
            except RedisError:
                raw = dict(self._local.get(connector_id, {}))
        else:
            raw = dict(self._local.get(connector_id, {}))
        return {runtime_id: _parse_wait(runtime_id, value) for runtime_id, value in raw.items()}

    async def on_connector(self, connector_id: str) -> dict[str, str]:
        """Waiting runtimes of a device and their users (aliases resolved)."""
        if self._coordinator is not None:
            try:
                raw = dict(await self._coordinator.client.hgetall(self._key(connector_id)) or {})
            except RedisError:
                raw = dict(self._local.get(connector_id, {}))
        else:
            raw = dict(self._local.get(connector_id, {}))
        return dict(_parse_wait(runtime_id, value) for runtime_id, value in raw.items())


def _parse_wait(runtime_id: str, value: str) -> tuple[str, str]:
    """``user`` waits on the runtime itself; ``user<TAB>runtime`` on the runtime it serves."""
    if value.startswith("{"):
        data = json.loads(value)
        value = str(data["user"])
    user_id, _, served = value.partition("\t")
    return (served or runtime_id, user_id)


class ChannelDriver:
    """Runs at most one switch per runtime: one task in this process, one claim across workers."""

    def __init__(self, coordinator: RedisCoordinator | None, *, wait: bool = False, store: Any = None) -> None:
        self._coordinator = coordinator if coordinator is not None and coordinator.distributed else None
        self._tasks: dict[tuple[str, str], asyncio.Task[None]] = {}
        # Tests (and single-request tools) finish switches before answering.
        self.wait = wait
        self._store = store
        self._slots = asyncio.Semaphore(8)

    def running(self, connector_id: str, runtime_id: str) -> asyncio.Task[None] | None:
        task = self._tasks.get((connector_id, runtime_id))
        return task if task is not None and not task.done() else None

    def spawn(self, connector_id: str, runtime_id: str, work: Callable[[], Awaitable[None]]) -> asyncio.Task[None]:
        key = (connector_id, runtime_id)
        current = self.running(*key)
        if current is not None:
            return current

        async def run() -> None:
            async with self._slots:
                if self._store is None:
                    await work()
                    return
                owner = secrets.token_urlsafe(18)
                cache_key = self._coordinator.key("channel-drive", *key) if self._coordinator else None
                if cache_key:
                    try:
                        if not await self._coordinator.claim(cache_key, owner, ttl_seconds=60):
                            return
                    except RedisError:
                        cache_key = None
                epoch = await self._store.claim_channel_execution(*key, owner)
                if epoch is None:
                    if cache_key:
                        try:
                            await self._coordinator.delete_if_value(cache_key, owner)
                        except RedisError:
                            pass
                    return
                parent = asyncio.current_task()
                async def renew() -> None:
                    try:
                        while True:
                            await asyncio.sleep(15)
                            if cache_key:
                                try:
                                    await self._coordinator.refresh_if_value(cache_key, owner, ttl_seconds=60)
                                except RedisError:
                                    pass
                            if not await self._store.renew_channel_execution(*key, owner, epoch):
                                logger.warning("channel lease lost connector_id={} runtime_id={}", *key)
                                parent.cancel()
                                return
                    except asyncio.CancelledError:
                        raise
                    except Exception:  # noqa: BLE001 - background failures retain durable work
                        logger.exception("channel lease renewal failed connector_id={} runtime_id={}", *key)
                        parent.cancel()
                heartbeat = asyncio.create_task(renew())
                try:
                    async with self._store.channel_execution(*key, owner, epoch):
                        await work()
                except asyncio.CancelledError:
                    raise
                except Exception:  # noqa: BLE001 - background failures retain durable work
                    logger.exception("channel execution failed connector_id={} runtime_id={}", *key)
                finally:
                    heartbeat.cancel()
                    await asyncio.gather(heartbeat, return_exceptions=True)
                    await self._store.renew_channel_execution(*key, owner, epoch, release=True)
                    if cache_key:
                        try:
                            await self._coordinator.delete_if_value(cache_key, owner)
                        except RedisError:
                            pass

        task = asyncio.create_task(run(), name=f"channel-switch-{key[0]}-{key[1]}")
        self._tasks[key] = task
        def completed(finished: asyncio.Task[None]) -> None:
            if self._tasks.get(key) is finished:
                self._tasks.pop(key, None)
            if not finished.cancelled() and (error := finished.exception()) is not None:
                logger.opt(exception=error).error("channel driver failed connector_id={} runtime_id={}", *key)
        task.add_done_callback(completed)
        return task

    async def close(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@dataclass(slots=True)
class _Context:
    """Everything one runtime's decision needs, read once."""

    user_id: str
    runtime: DeviceRuntimeView
    managed: DeviceRuntimeView | None
    override: dict[str, Any] | None
    desired: str
    actual: str
    # The runtime the actual channel lives on (the runtime or its managed instance).
    actual_target: DeviceRuntimeView
    assignment: dict[str, Any] | None
    profiles: dict[str, dict[str, Any]]


class ModelChannelService:
    def __init__(
        self,
        store: ModelChannelRepository,
        model_config: ModelConfigService,
        runtimes: DeviceRuntimeService,
        *,
        wake: ChannelWakeIndex,
        driver: ChannelDriver,
        broker: TimelineBroker | None = None,
        secret_box: Callable[[], SecretBox] = SecretBox,
    ) -> None:
        self._store = store
        self._model_config = model_config
        self._runtimes = runtimes
        self._wake = wake
        self._driver = driver
        self._broker = broker
        self._secret_box = secret_box
        self._spawned: list[asyncio.Task[None]] = []

    # Reading.

    async def selection(self, user_id: str) -> dict[str, Any]:
        stored = await self._store.get_channel_selection(user_id)
        if stored is not None:
            return stored
        # Before channels existed: an enabled Anywhere switch or Tokens assignments meant Anywhere.
        legacy = await self._store.get_setting(f"tokens_channel:{user_id}")
        channel = NATIVE
        if legacy == "true":
            channel = TOKENS
        elif legacy is None:
            profiles = {p["id"]: p for p in await self._store.list_model_profiles(user_id=user_id)}
            if any(profiles.get(a["profileId"], {}).get("source") == "tokens"
                   for a in await self._store.list_runtime_assignments(user_id=user_id)):
                channel = TOKENS
        return {"channel": channel, "revision": 0, "updatedAt": None}

    async def state(self, *, user_id: str, runtime_rows: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        """The channel state every client renders; see docs/api/model-config.md."""
        selection = await self.selection(user_id)
        rows = runtime_rows if runtime_rows is not None else await self._store.list_user_device_runtimes(user_id=user_id)
        runtimes = [DeviceRuntimeView.model_validate(row) for row in rows]
        overrides = {(o["connectorId"], o["runtimeId"]): o for o in await self._store.list_channel_overrides(user_id=user_id)}
        switches = {(s["connectorId"], s["runtimeId"]): s for s in await self._store.list_channel_switches(user_id=user_id)}
        syncs = {(x["connector_id"], x["runtime_id"]): x for x in await self._store.list_channel_sync(user_id)}
        assignments = {(a["connectorId"], a["runtimeId"]): a for a in await self._store.list_runtime_assignments(user_id=user_id)}
        profiles = {p["id"]: p for p in await self._store.list_model_profiles(user_id=user_id)}
        managed = {(r.connectorId, r.runtimeType): r for r in runtimes
                   if r.managedBy == MANAGED_BY and not r.runtimeId.startswith("rti_channel_")}
        items = []
        for runtime in runtimes:
            if runtime.managedBy == MANAGED_BY or not runtime.modelConnection:
                continue
            key = (runtime.connectorId, runtime.runtimeId)
            override = overrides.get(key)
            desired = override["channel"] if override else selection["channel"]
            expected_id = managed_channel_runtime_id(runtime.connectorId, runtime.runtimeId)
            instance = next((r for r in runtimes if r.connectorId == runtime.connectorId and r.runtimeId == expected_id
                             and r.managedBy == MANAGED_BY), None)
            if instance is None and runtime.runtimeId == runtime.runtimeType:
                instance = managed.get((runtime.connectorId, runtime.runtimeType))
            actual, _, assignment = _actual(runtime, instance, assignments, profiles)
            switch = switches.get(key)
            item = {
                "connectorId": runtime.connectorId,
                "runtimeId": runtime.runtimeId,
                "override": override["channel"] if override else None,
                "desired": desired,
                "actual": actual,
                "state": APPLIED,
                "step": None,
                "reason": None,
                "message": None,
                "updatedAt": switch["updatedAt"] if switch else None,
            }
            if switch is not None and switch["state"] != APPLIED:
                item.update(state=switch["state"], step=switch["step"], reason=switch["reason"],
                            message=switch["message"])
            elif actual != desired:
                # Not yet decided (e.g. a runtime discovered after the switch).
                item["state"] = PENDING
            elif assignment is not None and _outdated(assignment, profiles):
                item["state"] = PENDING
            sync = syncs.get(key)
            if sync:
                item.update(desiredGeneration=sync["desired_generation"], appliedGeneration=sync["applied_generation"],
                            observedAt=sync["observed_at"], retryAt=sync["next_retry_at"])
                if sync["actual_channel"] is not None:
                    item["actual"] = sync["actual_channel"]
                if sync["applied_generation"] != sync["desired_generation"] and item["state"] == APPLIED:
                    item["state"] = PENDING
            items.append(item)
        started = [s["startedAt"] for s in switches.values() if s.get("startedAt")]
        switch_info = None
        if switches or selection["revision"]:
            state = switch_state([item["state"] for item in items])
            finished = None
            if state != "running":
                finished = max((s["updatedAt"] for s in switches.values()), default=None)
            switch_info = {
                "revision": selection["revision"],
                "state": state,
                "startedAt": max(started) if started else selection.get("updatedAt"),
                "finishedAt": finished,
            }
        return {
            "channel": selection["channel"],
            "revision": selection["revision"],
            "switch": switch_info,
            "runtimes": items,
        }

    # Changing what runtimes should use.

    async def set_channel(self, channel: str, *, user_id: str) -> dict[str, Any]:
        async with self._store.channel_transaction(user_id):
            await self._check_channel(channel, user_id=user_id)
            await self._store.save_channel_selection(user_id, channel)
            await self._store.refresh_channel_targets(user_id)
        await self._plan(user_id)
        return await self._respond(user_id)

    async def set_runtime_channel(
        self, connector_id: str, runtime_id: str, channel: str | None, *, user_id: str, confirm_native_global: bool,
    ) -> dict[str, Any]:
        runtime = await self._owned(connector_id, runtime_id, user_id=user_id)
        if runtime.managedBy == MANAGED_BY:
            raise ModelConfigConflictError("runtime_managed", "choose the channel on the runtime this instance serves")
        if channel is not None:
            await self._check_channel(channel, user_id=user_id)
            if (channel != NATIVE and (runtime.modelConnection or {}).get("scope") == "native_global"
                    and not confirm_native_global):
                raise ModelConfigConflictError(
                    "confirmation_required", "this changes the runtime's own global configuration"
                )
        async with self._store.channel_transaction(user_id):
            await self._store.set_channel_override(
                connector_id, runtime_id, channel, confirm_native_global=confirm_native_global
            )
            await self._store.save_channel_selection(user_id)
            await self._store.refresh_channel_targets(user_id)
        await self._plan(user_id, only=(connector_id, runtime_id))
        return await self._respond(user_id)

    async def retry(self, *, user_id: str, connector_id: str | None = None, runtime_id: str | None = None) -> dict[str, Any]:
        for switch in await self._store.list_channel_switches(user_id=user_id):
            if switch["state"] not in NEEDS_RETRY:
                continue
            if connector_id and (switch["connectorId"], switch["runtimeId"]) != (connector_id, runtime_id):
                continue
            await self._store.request_channel_retry(switch["connectorId"], switch["runtimeId"])
        await self._plan(user_id, only=(connector_id, runtime_id) if connector_id and runtime_id else None)
        return await self._respond(user_id)

    async def refresh(self, *, user_id: str, rewrite: str | None = None) -> bool:
        """Rewrite runtimes whose channel's models or key changed; True if any will be.

        ``rewrite`` names a channel whose runtimes are written again even if
        nothing they can compare changed, e.g. after its key was rotated.
        """
        async with self._store.channel_transaction(user_id):
            await self._store.save_channel_selection(user_id)
            if rewrite is not None:
                await self._store.bump_channel_connection(user_id, rewrite)
            await self._store.refresh_channel_targets(user_id)
        moving = await self._plan(user_id, rewrite=rewrite)
        await self.settle()
        return moving

    async def tokens_in_use(self, *, user_id: str) -> bool:
        state = await self.state(user_id=user_id)
        return state["channel"] == TOKENS or any(
            TOKENS in (item["desired"], item["actual"]) for item in state["runtimes"]
        )

    async def runtimes_on(self, channel: str, *, user_id: str) -> list[tuple[str, str]]:
        state = await self.state(user_id=user_id)
        return [(i["connectorId"], i["runtimeId"]) for i in state["runtimes"] if i["actual"] == channel]

    async def would_interrupt(self, targets: list[tuple[str, str]], *, user_id: str) -> bool:
        for connector_id, runtime_id in targets:
            runtime = await self._owned(connector_id, runtime_id, user_id=user_id)
            context = await self._context(runtime, user_id=user_id)
            target = context.actual_target
            if target.modelConnection and target.active \
                    and target.status in RESTARTING_STATUSES and await self._busy(context.runtime, target):
                return True
        return False

    # Events.

    async def runtime_event(self, connector_id: str, runtime_id: str) -> None:
        """Something happened to a runtime (a task ended, it started): resume its wait."""
        waiting = await self._wake.waiting(connector_id, runtime_id)
        if waiting is not None:
            self._spawn(connector_id, *waiting)
        await self.settle()

    async def connector_discovered(self, connector_id: str) -> None:
        """Discovery finished: fix each runtime's target before the device gate opens."""
        owner = await self._store.channel_connector_owner(connector_id)
        if owner is not None:
            await self._ensure_targets(owner)

    async def connector_event(self, connector_id: str) -> None:
        """The device is back: every runtime waiting on it may go on."""
        # Always enumerate durable state; a missing Redis marker cannot hide work.
        owner = await self._store.channel_connector_owner(connector_id)
        if owner is not None:
            await self._store.refresh_channel_targets(owner)
            await self._plan(owner, connector=connector_id, reconnect=True)
        await self.settle()

    async def resume(self) -> None:
        """At startup: register waits again and take over switches a dead worker left."""
        # Legacy deferred assignments and newly discovered runtimes can be due
        # without a persisted switch. Recover those before resuming known jobs.
        for user_id in await self._store.list_channel_runtime_users():
            await self.recover_missing(user_id=user_id)
        for switch in await self._store.list_unfinished_channel_switches(states=UNFINISHED):
            await self._wake.mark(switch["connectorId"], switch["runtimeId"], switch["userId"])
            if switch["state"] in IN_FLIGHT or switch["state"] == PENDING:
                self._spawn(switch["connectorId"], switch["runtimeId"], switch["userId"])

    async def kick(self, *, user_id: str) -> None:
        """A client looked at the channel: go on with anything that can now."""
        await self.recover_missing(user_id=user_id)
        for switch in await self._store.list_channel_switches(user_id=user_id):
            if switch["state"] in UNFINISHED:
                self._spawn(switch["connectorId"], switch["runtimeId"], user_id)
        await self.settle()

    # Requests reaching runtimes.

    async def prepare_runtime(self, connector_id: str, runtime_id: str, *, user_id: str) -> str:
        """Before a session or catalog: the instance to use, with any due switch done first."""
        try:
            runtime = await self._owned(connector_id, runtime_id, user_id=user_id)
        except ModelConfigNotFoundError:
            # Not a configured instance (e.g. addressed by its type): nothing to switch.
            return runtime_id
        base = runtime
        if runtime.managedBy == MANAGED_BY:
            base = await self._served_runtime(runtime, user_id=user_id) or runtime
        await self._store.refresh_channel_targets(user_id)
        await self._plan(user_id, only=(base.connectorId, base.runtimeId))
        switch = await self._store.get_channel_switch(base.connectorId, base.runtimeId)
        if switch is not None and switch["state"] in (PENDING, WAITING_ONLINE, *IN_FLIGHT):
            task = self._spawn(base.connectorId, base.runtimeId, user_id)
            # Wait for configuration application, never for running tasks to end.
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=ADMISSION_WAIT_SECONDS)
            except TimeoutError:
                pass
        switch = await self._store.get_channel_switch(base.connectorId, base.runtimeId)
        if switch and switch["state"] in (FAILED, PENDING, WAITING_ONLINE, *IN_FLIGHT):
            raise ModelChannelError("runtime_switching", "runtime channel reconciliation has not completed")
        context = await self._context(base, user_id=user_id)
        # Sessions go where the runtime's channel actually is right now.
        return context.actual_target.runtimeId

    @asynccontextmanager
    async def admit(self, connector_id: str, runtime_id: str, *, user_id: str | None) -> AsyncIterator[None]:
        """Hold a runtime open until the request's task has started; waits out a switch."""
        gate = [runtime_id]
        try:
            runtime = DeviceRuntimeView.model_validate(
                await self._runtimes._store.get_device_runtime(connector_id, runtime_id)
            )
            if runtime.managedBy == MANAGED_BY and user_id is not None:
                served = await self._served_runtime(runtime, user_id=user_id)
                if served is not None:
                    gate.append(served.runtimeId)
        except KeyError:
            pass
        token = f"adm_{secrets.token_urlsafe(12)}"
        deadline = asyncio.get_running_loop().time() + ADMISSION_WAIT_SECONDS
        while True:
            now = _now()
            if await self._store.admit_runtime_request(
                connector_id, runtime_id, gate_runtime_ids=gate, token=token,
                expires_at=_iso(now + ADMISSION_TTL), now=_iso(now),
            ):
                break
            if asyncio.get_running_loop().time() >= deadline:
                raise ModelChannelError(
                    "runtime_switching", "this runtime is switching its model channel; try again shortly"
                )
            await asyncio.sleep(1.0)
        try:
            yield
        finally:
            await self._store.release_runtime_request(token)
            # The request may have been the last thing a waiting switch needed.
            await self.runtime_event(connector_id, runtime_id)

    async def channel_catalog(
        self, connector_id: str, runtime_id: str, catalog: ProtocolModelCatalog, *, user_id: str,
    ) -> ProtocolModelCatalog:
        """Only the models the runtime's actual channel serves, keeping native IDs."""
        assignment = await self._store.get_runtime_assignment(connector_id, runtime_id)
        if assignment is None:
            return catalog
        profiles = {p["id"]: p for p in await self._store.list_model_profiles(user_id=user_id)}
        profile = profiles.get(assignment["profileId"])
        if profile is None or profile["state"] != "active":
            return catalog
        runtime = await self._owned(connector_id, runtime_id, user_id=user_id)
        if (public_runtime_view(runtime).modelConnectionStatus or {}).get("state") == "managed_externally":
            return catalog
        offer = next((item for item in _offers(profile) if item.format == assignment["offerFormat"]), None)
        if offer is None or not offer.models:
            return catalog
        specs = {item.id: item for item in offer.models}
        models = [item.model_copy(update={"displayName": specs[item.id].name or item.displayName})
                  for item in catalog.models if item.id in specs]
        if models and not any(item.default for item in models):
            models[0] = models[0].model_copy(update={"default": True})
        return catalog.model_copy(update={"models": models})

    # Planning: which runtimes need to move.

    async def recover_missing(self, *, user_id: str) -> None:
        """Turn an inferred pending state into a job; preserve every existing job."""
        await self._store.refresh_channel_targets(user_id)
        await self._plan(user_id)
        await self.settle()

    async def _ensure_targets(self, user_id: str) -> None:
        if await self._store.get_channel_selection(user_id) is None:
            selection = await self.selection(user_id)
            async with self._store.channel_transaction(user_id):
                if await self._store.get_channel_selection(user_id) is None:
                    await self._store.save_channel_selection(user_id, selection["channel"])
        await self._store.refresh_channel_targets(user_id)

    async def _plan(
        self, user_id: str, *, only: tuple[str, str] | None = None,
        rewrite: str | None = None, connector: str | None = None, reconnect: bool = False,
    ) -> bool:
        await self._ensure_targets(user_id)
        rows = await self._store.list_user_device_runtimes(user_id=user_id)
        moving = False
        for row in rows:
            runtime = DeviceRuntimeView.model_validate(row)
            if runtime.managedBy == MANAGED_BY or not runtime.modelConnection:
                continue
            if only is not None and (runtime.connectorId, runtime.runtimeId) != only:
                continue
            if connector is not None and runtime.connectorId != connector:
                continue
            switch = await self._store.get_channel_switch(runtime.connectorId, runtime.runtimeId)
            sync = await self._store.get_channel_sync(runtime.connectorId, runtime.runtimeId)
            due = sync is not None and (sync["desired_generation"] != sync["applied_generation"]
                    or (switch is not None and switch["state"] in UNFINISHED))
            if not due and not reconnect:
                continue
            if not due and reconnect and switch is not None and switch["state"] == APPLIED:
                # Periodic scans reach offline devices too; those verify when they are back.
                if await self._connector_online(runtime.connectorId):
                    self._spawn(runtime.connectorId, runtime.runtimeId, user_id)
                continue
            if (switch and sync and switch["state"] == WAITING_ONLINE
                    and switch.get("targetGeneration") == sync["desired_generation"]
                    and not await self._connector_online(runtime.connectorId)):
                continue
            if switch is not None and switch["state"] in (*NEEDS_RETRY, UNSUPPORTED):
                same_target = switch.get("targetGeneration") == (sync or {}).get("desired_generation")
                upgrade = (reconnect and switch.get("reason") == "connector_upgrade_required"
                           and await self._runtimes.connector_supports(runtime.connectorId, "channelReconcileFence"))
                if same_target and not upgrade and not (sync and sync["next_retry_at"] and sync["next_retry_at"] <= utc_now()):
                    continue
            if sync and sync["next_retry_at"] and sync["next_retry_at"] > utc_now() and not reconnect:
                continue
            moving = True
            same_generation = switch is not None and sync is not None and switch.get("targetGeneration") == sync["desired_generation"]
            values: dict[str, Any] = {"userId": user_id,
                "targetGeneration": sync["desired_generation"] if sync else None,
                "startedAt": switch.get("startedAt") if same_generation and switch.get("startedAt") else utc_now()}
            if switch is None or switch["state"] not in IN_FLIGHT:
                values.update(state=RESTORING if switch and switch["state"] == FAILED and switch.get("snapshotCiphertext") else PENDING,
                              step=None, reason=None, message=None)
            await self._store.plan_channel_switch(runtime.connectorId, runtime.runtimeId, values)
            await self._wake.mark(runtime.connectorId, runtime.runtimeId, user_id,
                                  sync["desired_generation"] if sync else 0)
            self._spawn(runtime.connectorId, runtime.runtimeId, user_id)
        if moving:
            await self._publish(user_id)
        return moving

    async def _connector_online(self, connector_id: str) -> bool:
        try:
            return await self._runtimes.is_connector_online(connector_id)
        except RedisError:
            return False

    async def _reset(self, connector_id: str, runtime_id: str, *, user_id: str) -> None:
        switch = await self._store.get_channel_switch(connector_id, runtime_id)
        if switch is not None and switch["state"] in NEEDS_RETRY:
            await self._store.save_channel_switch(connector_id, runtime_id, {
                "userId": user_id, "state": PENDING, "reason": None, "message": None,
            })

    def _spawn(self, connector_id: str, runtime_id: str, user_id: str) -> asyncio.Task[None]:
        task = self._driver.spawn(connector_id, runtime_id, lambda: self._drive(connector_id, runtime_id, user_id))
        if self._driver.wait and task is not asyncio.current_task():
            self._spawned.append(task)
        return task

    async def settle(self) -> None:
        """With a waiting driver, finish the switches this call started."""
        while self._driver.wait and self._spawned:
            tasks, self._spawned = self._spawned, []
            await asyncio.gather(*tasks, return_exceptions=True)

    # Driving one runtime.

    async def _drive(self, connector_id: str, runtime_id: str, user_id: str) -> None:
        for _ in range(4):
            if await self._store.channel_discovery_gated(connector_id):
                return
            switch = await self._store.get_channel_switch(connector_id, runtime_id)
            if switch is None:
                return
            if switch["state"] in IN_FLIGHT:
                before = switch["updatedAt"]
                await self._recover(switch, user_id=user_id)
                after = await self._store.get_channel_switch(connector_id, runtime_id)
                if after is None or (after["state"] in IN_FLIGHT and after["updatedAt"] == before):
                    return  # still owned elsewhere, or waiting for the device
                continue
            try:
                runtime = await self._owned(connector_id, runtime_id, user_id=user_id)
            except ModelConfigError:
                return
            if not runtime.modelConnection:
                return
            async with self._store.channel_transaction(user_id):
                context = await self._context(runtime, user_id=user_id)
                sync = await self._store.get_channel_sync(connector_id, runtime_id)
            if not await self._runtimes.is_connector_online(connector_id):
                # An applied target has nothing to wait for; coming back verifies it.
                if switch["state"] != APPLIED or not sync or sync["applied_generation"] != sync["desired_generation"]:
                    await self._wait_online(connector_id, runtime_id, user_id)
                return
            if not await self._runtimes.connector_supports(connector_id, "channelReconcileFence"):
                await self._settle(connector_id, runtime_id, user_id, UNSUPPORTED, reason="connector_upgrade_required")
                return
            if switch["state"] in NEEDS_RETRY and switch.get("targetGeneration") == (sync or {}).get("desired_generation"):
                return
            if sync and sync["applied_generation"] == sync["desired_generation"] and context.desired == context.actual:
                target = context.actual_target
                report = await self._runtimes.read_connector_config(connector_id, target.runtimeId, target.runtimeType)
                if report is None:
                    # An unanswered check does not undo an applied target; the next scan asks again.
                    if switch["state"] != APPLIED:
                        await self._store.channel_retry(connector_id, runtime_id, "device_offline", automatic=True)
                        await self._store.save_channel_switch(connector_id, runtime_id, {"state": PENDING, "reason": "device_offline"})
                    return
                if report["running"] == target.active and (not target.active or connection_digest(
                    report["values"], target.modelConnection or {}) == sync["actual_config_digest"]):
                    observed_status = "running" if report["running"] else "stopped"
                    status_changed = target.status != observed_status
                    async with self._store.channel_transaction(user_id):
                        latest = await self._store.get_channel_sync(connector_id, runtime_id)
                        if latest["desired_generation"] != sync["desired_generation"]:
                            continue
                        await self._store.record_channel_observation(connector_id, runtime_id,
                            generation=sync["desired_generation"], channel=context.desired,
                            digest=sync["actual_config_digest"], instance_id=report.get("instanceId") or sync["observed_instance_id"])
                        if status_changed:
                            await self._runtimes._store.set_device_runtime_status(connector_id, target.runtimeId, observed_status)
                        if switch["state"] != APPLIED or status_changed:
                            await self._settle(connector_id, runtime_id, user_id, APPLIED)
                    return
            if context.desired == context.actual and not (
                context.assignment is not None and _outdated(context.assignment, context.profiles)
            ):
                try:
                    plan = await self._plan_write(context)
                except ModelConfigError:
                    # The profile/key may have changed during the external lookup.
                    # The executor re-captures its target and records recoverable failures.
                    await self._execute(context, switch)
                    continue
                target = plan["target"]
                if target is not None:
                    report = await self._runtimes.read_connector_config(connector_id, target.runtimeId, target.runtimeType)
                    expected = connection_digest(plan["config"], target.modelConnection or {})
                    if report and (not plan["active"] or report["running"]) and connection_digest(
                        report["values"], target.modelConnection or {}) == expected:
                        async with self._store.channel_transaction(user_id):
                            latest = await self._store.get_channel_sync(connector_id, runtime_id)
                            if not sync or latest["desired_generation"] != sync["desired_generation"]:
                                continue
                            await self._store.save_channel_switch(connector_id, runtime_id,
                                {"targetGeneration": sync["desired_generation"], "targetChannel": context.desired})
                            await self._store.record_channel_observation(connector_id, runtime_id,
                                generation=sync["desired_generation"], channel=context.desired, digest=expected,
                                instance_id=report.get("instanceId"))
                            await self._settle(connector_id, runtime_id, user_id, APPLIED)
                        return
            reason = self._unsupported(context)
            if reason is not None:
                await self._settle(connector_id, runtime_id, user_id, UNSUPPORTED, reason=reason)
                return
            target = context.actual_target if context.desired == NATIVE else (context.managed if self._needs_managed(context) else context.runtime)
            if target is not None and not await self._runtimes.is_connector_online(connector_id):
                await self._wait_online(connector_id, runtime_id, user_id)
                return
            await self._execute(context, switch)
            # Done unless the wanted channel changed while this one ran; the commit verified it.
            if await self._reached_target(connector_id, runtime_id):
                return
        await self._store.enqueue_channel_sync(user_id, connector_id)

    async def _reached_target(self, connector_id: str, runtime_id: str) -> bool:
        switch = await self._store.get_channel_switch(connector_id, runtime_id)
        sync = await self._store.get_channel_sync(connector_id, runtime_id)
        return (switch is not None and sync is not None and switch["state"] == APPLIED
                and sync["applied_generation"] == sync["desired_generation"])

    def _needs_managed(self, context: _Context) -> bool:
        capability = context.runtime.modelConnection or {}
        runtime = context.runtime
        return bool(capability) and plan_mode(
            capability, runtime.config if runtime.configured else None, runtime.defaults
        ).needs_new_instance

    def _unsupported(self, context: _Context) -> str | None:
        if context.desired == NATIVE:
            return None
        runtime = context.runtime
        capability = runtime.modelConnection
        if not capability:
            return "model_connection_unsupported"
        if not runtime.present:
            return "not_installed"
        if not runtime.configured:
            return "not_configured"
        profile = _channel_profile(context.desired, context.profiles)
        if profile is None:
            return "profile_unavailable"
        if capability.get("scope") == "native_global" and not (
            context.override and context.override.get("confirmNativeGlobal")
        ):
            return "confirmation_required"
        match = match_offer(capability, _offers(profile))
        if match.offer is None:
            return match.reason or "format_unsupported"
        mode = plan_mode(capability, runtime.config, runtime.defaults)
        if mode.field and mode.target is None:
            return "mode_unsupported"
        return None

    async def _execute(self, context: _Context, switch: dict[str, Any]) -> None:
        connector_id, runtime_id = context.runtime.connectorId, context.runtime.runtimeId
        operation_id = f"chs_{secrets.token_urlsafe(12)}"
        async with self._store.channel_transaction(context.user_id):
            sync = await self._store.get_channel_sync(connector_id, runtime_id)
            current = await self._owned(connector_id, runtime_id, user_id=context.user_id)
            context = await self._context(current, user_id=context.user_id)
            if sync is not None:
                await self._store.save_channel_switch(connector_id, runtime_id, {
                    "targetGeneration": sync["desired_generation"], "targetSpecDigest": sync["desired_spec_digest"],
                    "targetChannel": context.desired})
        if sync is None:
            return
        try:
            plan = await self._plan_write(context)
        except ModelConfigError as exc:
            if exc.code in UNSUPPORTED_CODES:
                await self._settle(connector_id, runtime_id, context.user_id, UNSUPPORTED,
                                   reason=exc.code, message=exc.message)
            else:
                # Nothing was touched (e.g. the key could not be fetched); the user may retry.
                await self._settle(connector_id, runtime_id, context.user_id, RESTORED,
                                   reason=exc.code, message=exc.message, target=context.desired)
            return
        latest = await self._store.get_channel_sync(connector_id, runtime_id)
        if latest["desired_generation"] != sync["desired_generation"]:
            return
        revision = await self._store.next_switch_revision(connector_id, runtime_id)
        box = self._box()
        target = plan["target"]
        plan["baseConfig"] = target.config if target is not None else None
        snapshot = {
            "runtimeId": target.runtimeId if target is not None else None,
            "created": False,
            "before": None if target is None else {
                "config": target.config,
                "configured": target.configured,
                "active": target.active,
                "assignment": await self._store.get_runtime_assignment(connector_id, target.runtimeId),
            },
            "after": plan["after"],
            "desiredGeneration": sync["desired_generation"],
            "desiredChannel": context.desired,
            "previousChannel": context.actual, "previousGeneration": sync["applied_generation"],
            "planConfig": plan["config"], "planActive": plan["active"],
        }
        if target is None:
            snapshot["runtimeId"] = managed_channel_runtime_id(connector_id, runtime_id)
            snapshot["created"] = True
            plan["reservedId"] = snapshot["runtimeId"]
        sealed = box.seal(json.dumps(snapshot), context=f"channel-snapshot:{connector_id}:{runtime_id}")
        async with self._store.channel_transaction(context.user_id):
            current_sync = await self._store.get_channel_sync(connector_id, runtime_id)
            if current_sync["desired_generation"] != sync["desired_generation"]:
                return
            await self._store.save_channel_switch(connector_id, runtime_id, {
                "userId": context.user_id, "state": SWITCHING, "step": PREPARING, "targetChannel": context.desired,
                "operationId": operation_id, "snapshotCiphertext": sealed, "reason": None, "message": None,
                "targetGeneration": sync["desired_generation"], "targetSpecDigest": sync["desired_spec_digest"],
                "expectedConfigDigest": connection_digest(plan["config"], (target or context.runtime).modelConnection or {}),
                "planCiphertext": sealed,
                "leaseUntil": _iso(_now() + LEASE), "startedAt": switch.get("startedAt") or utc_now(),
            })
        await self._publish(context.user_id)
        fence = {"operationId": operation_id, "switchRevision": revision,
                 "targetGeneration": sync["desired_generation"], "logicalRuntimeId": runtime_id}
        # Close the runtime to new tasks, then let the ones admitted before that start.
        gate = sorted({runtime_id, snapshot["runtimeId"], context.actual_target.runtimeId,
                       *([context.managed.runtimeId] if context.managed is not None else [])})
        admitted = await self._store.close_runtime_for_switch(
            connector_id, runtime_id,
            {"step": ACTIVATING, "leaseUntil": _iso(_now() + LEASE)},
            count_runtime_ids=gate, now=_iso(_now()),
        )
        await self._publish(context.user_id)
        await self._drain_admissions(connector_id, gate, admitted)
        latest = await self._store.get_channel_sync(connector_id, runtime_id)
        if latest["desired_generation"] != sync["desired_generation"]:
            await self._settle(connector_id, runtime_id, context.user_id, PENDING)
            return
        if target is None:
            await self._create_managed(context, plan, switch_row=(connector_id, runtime_id), fence=fence, snapshot=snapshot)
            return
        ok, reason, message = await self._activate(context, target, plan, fence)
        if ok:
            await self._commit(context, target, plan)
            return
        if reason == "target_changed":
            await self._settle(connector_id, runtime_id, context.user_id, PENDING)
            return
        if reason == OFFLINE:
            await self._store.save_channel_switch(connector_id, runtime_id, {
                "step": VERIFYING, "leaseUntil": _iso(_now()),
            })
            await self._wake.mark(connector_id, runtime_id, context.user_id)
            await self._publish(context.user_id)
            return
        await self._rollback(connector_id, runtime_id, context.user_id, snapshot, reason=reason, message=message)

    async def _drain_admissions(self, connector_id: str, runtime_ids: list[str], admitted: int) -> None:
        """Wait for admitted requests to start their task; started tasks are not waited for."""
        deadline = asyncio.get_running_loop().time() + ADMISSION_DRAIN_SECONDS
        while admitted:
            if asyncio.get_running_loop().time() >= deadline:
                logger.warning("channel switch proceeding with admitted requests connector_id={} runtime_ids={} count={}",
                               connector_id, runtime_ids, admitted)
                return
            await asyncio.sleep(ADMISSION_DRAIN_INTERVAL_SECONDS)
            admitted = await self._store.count_runtime_admissions(connector_id, runtime_ids, now=_iso(_now()))

    async def _plan_write(self, context: _Context) -> dict[str, Any]:
        """The configuration to write and the assignment to keep afterwards."""
        runtime = context.runtime
        if context.desired == NATIVE:
            target = context.actual_target
            assignment = context.assignment
            capability = target.modelConnection or {}
            if assignment is None:
                return {"target": target, "config": target.config, "active": target.active,
                        "restarts": target.active, "after": None}
            if assignment["createdRuntime"]:
                # The managed instance is AA's own: it is only stopped.
                return {"target": target, "config": target.config, "active": False,
                        "restarts": target.active, "after": None}
            previous = None
            if assignment["previousGatewayCiphertext"]:
                opened = self._box().open(
                    assignment["previousGatewayCiphertext"],
                    context=f"previous-gateway:{target.connectorId}:{target.runtimeId}",
                )
                previous = json.loads(opened) if opened else None
            config = revert_patch(
                config=target.config or {}, capability=capability,
                previous_gateway=previous, imported=assignment["importedModelIds"],
            )
            return {"target": target, "config": config, "active": target.active,
                    "restarts": target.active, "after": None}
        profile = _channel_profile(context.desired, context.profiles)
        assert profile is not None
        capability = runtime.modelConnection or {}
        offer = match_offer(capability, _offers(profile)).offer
        assert offer is not None
        api_key = await self._model_config.profile_key(profile, user_id=context.user_id)
        managed = self._needs_managed(context)
        target = context.managed if managed else runtime
        if managed and target is None:
            config, imported = self._patch(dict(runtime.defaults), capability, offer, api_key, [], plan_mode(
                capability, runtime.config, runtime.defaults))
            return {"target": None, "config": config, "active": True, "restarts": False, "after": {
                "profileId": profile["id"], "offerFormat": offer.format, "createdRuntime": True,
                "importedModelIds": imported, "previousGatewayCiphertext": None,
                "catalogDigest": profile["catalogDigest"],
                "digest": connection_digest(config, capability),
            }}
        assert target is not None
        existing = await self._store.get_runtime_assignment(target.connectorId, target.runtimeId)
        created = managed or bool(existing and existing["createdRuntime"])
        if created:
            previous_ciphertext = None
        elif existing is not None:
            previous_ciphertext = existing["previousGatewayCiphertext"]
        else:
            gateway = (target.config or {}).get(capability["configField"])
            previous_ciphertext = self._box().seal(
                json.dumps(gateway), context=f"previous-gateway:{target.connectorId}:{target.runtimeId}"
            ) if isinstance(gateway, dict) else None
        base = dict(target.config) if target.configured and target.config is not None else dict(target.defaults)
        mode = plan_mode(capability, base if target.configured else None, target.defaults)
        config, imported = self._patch(base, capability, offer, api_key,
                                       existing["importedModelIds"] if existing else [], mode)
        return {"target": target, "config": config, "active": True if created else target.active,
                "restarts": target.active, "after": {
            "profileId": profile["id"], "offerFormat": offer.format, "createdRuntime": created,
            "importedModelIds": imported, "previousGatewayCiphertext": previous_ciphertext,
            "catalogDigest": profile["catalogDigest"],
            "digest": connection_digest(config, capability),
        }}

    def _patch(
        self, base: dict[str, Any], capability: dict[str, Any], offer: Offer, api_key: str,
        previous_imported: list[str], mode: Any,
    ) -> tuple[dict[str, Any], list[str]]:
        try:
            config, imported = apply_patch(
                config=base, capability=capability, offer=offer, api_key=api_key,
                previous_imported=previous_imported, model_ids=None, mode=mode, trim=True,
            )
        except ModelUnavailableError as exc:
            raise ModelConfigConflictError("model_unavailable", "the runtime's model is not in this channel") from exc
        except TooManyModelsError as exc:
            raise ModelConfigConflictError("too_many_models", "too many models for this runtime") from exc
        models_field = capability.get("modelsField")
        catalog = capability.get("catalog")
        if (isinstance(catalog, dict) and catalog.get("required") and isinstance(models_field, str)
                and not config.get(models_field)):
            raise ModelConfigConflictError("models_required", "this runtime needs at least one model")
        return config, imported

    async def _activate(
        self, context: _Context, target: DeviceRuntimeView, plan: dict[str, Any], fence: dict[str, Any],
    ) -> tuple[bool, str | None, str | None]:
        """Write and start the new configuration, then verify what the runtime runs."""
        connector_id = target.connectorId
        try:
            async with self._runtimes.locked_runtime(connector_id, target.runtimeId, user_id=context.user_id) as handle:
                if handle.runtime.config != plan.get("baseConfig"):
                    return False, "target_changed", None
                if plan["config"] != handle.runtime.config or (plan["active"] and handle.runtime.active):
                    # A switch always rebuilds a running instance from the full
                    # target config, even when the saved config is unchanged.
                    await handle.put_config(plan["config"], restart=True, fence=fence)
                if plan["active"] and not handle.runtime.active:
                    await handle.set_active(True, fence=fence)
                elif not plan["active"] and handle.runtime.active:
                    await handle.set_active(False, fence=fence)
                started = dict(handle.last_start)
        except DeviceRuntimeInvalidConfigError as exc:
            return False, "validate_failed", exc.message
        except DeviceRuntimeOfflineError:
            # Whether the new config started is unknown until the device is back.
            return False, OFFLINE, None
        except DeviceRuntimeError as exc:
            code = exc.detail.get("code") if isinstance(exc.detail, dict) else None
            # A newer switch already reached the Connector.
            if code == "channel_target_superseded":
                return False, "target_changed", None
            return False, "superseded" if code == "switch_revision_stale" else "start_failed", exc.message
        except TimeoutError:
            # The Connector may have started it anyway: verify asks what it runs.
            started = {}
        plan["instanceId"] = started.get("instanceId")
        await self._store.save_channel_switch(context.runtime.connectorId, context.runtime.runtimeId, {
            "step": VERIFYING, "leaseUntil": _iso(_now() + LEASE),
        })
        await self._publish(context.user_id)
        return await self._verify(target, plan, started)

    async def _verify(
        self, target: DeviceRuntimeView, plan: dict[str, Any], started: dict[str, Any],
    ) -> tuple[bool, str | None, str | None]:
        # A switch verifies configuration application, not upstream availability.
        # Billing, authentication and model errors belong to model requests and
        # must not roll back a configuration the runtime successfully loaded.
        capability = target.modelConnection or {}
        expected = connection_digest(plan["config"], capability)
        reported = started.get("configDigest")
        if isinstance(reported, str) and expected is not None and reported != expected:
            return False, "verify_failed", "the runtime loaded a different configuration"
        if not plan["active"]:
            return True, None, None
        deadline = asyncio.get_running_loop().time() + VERIFY_TIMEOUT_SECONDS
        delay = 0.5
        while True:
            row = DeviceRuntimeView.model_validate(
                await self._runtimes._store.get_device_runtime(target.connectorId, target.runtimeId)
            )
            status = (public_runtime_view(row).modelConnectionStatus or {}).get("state")
            actual = await self._runtimes.read_connector_config(target.connectorId, target.runtimeId, target.runtimeType)
            if actual and actual["running"] and connection_digest(actual["values"], capability) == expected and status != "failed":
                plan["instanceId"] = plan.get("instanceId") or actual.get("instanceId")
                if row.status != "running":
                    await self._runtimes._store.set_device_runtime_status(target.connectorId, target.runtimeId, "running")
                return True, None, None
            if row.status == "error":
                message = (row.error or {}).get("message") if isinstance(row.error, dict) else None
                return False, "start_failed", message
            if status == "failed":
                return False, "verify_failed", (public_runtime_view(row).modelConnectionStatus or {}).get("reason")
            if asyncio.get_running_loop().time() >= deadline:
                break
            await asyncio.sleep(delay)
            delay = min(delay * 2, 4.0)
        # No answer in time: believe only what the Connector says it runs.
        actual = await self._runtimes.read_connector_config(target.connectorId, target.runtimeId, target.runtimeType)
        if actual and actual["running"] and connection_digest(actual["values"], capability) == expected:
            return True, None, None
        return False, "verify_timeout", None

    async def _commit(self, context: _Context, target: DeviceRuntimeView, plan: dict[str, Any]) -> None:
        async with self._store.channel_transaction(context.user_id):
            after = plan["after"]
            connector_id, runtime_id = context.runtime.connectorId, context.runtime.runtimeId
            if after is None:
                if await self._store.get_runtime_assignment(target.connectorId, target.runtimeId) is not None:
                    await self._store.delete_runtime_assignment(target.connectorId, target.runtimeId)
            else:
                row = DeviceRuntimeView.model_validate(
                    await self._runtimes._store.get_device_runtime(target.connectorId, target.runtimeId)
                )
                await self._store.save_runtime_assignment(_assignment_values(target.connectorId, target.runtimeId, after, row))
            switch = await self._store.get_channel_switch(connector_id, runtime_id)
            generation = switch.get("targetGeneration")
            await self._store.record_channel_observation(connector_id, runtime_id, generation=generation,
                channel=switch.get("targetChannel") or context.desired,
                digest=connection_digest(plan["config"], target.modelConnection or {}), instance_id=plan.get("instanceId"))
            await self._settle(connector_id, runtime_id, context.user_id, APPLIED, publish=False)
        await self._publish(context.user_id)

    async def _create_managed(
        self, context: _Context, plan: dict[str, Any], *, switch_row: tuple[str, str], fence: dict[str, Any],
        snapshot: dict[str, Any],
    ) -> None:
        runtime = context.runtime
        after = plan["after"]
        profile = context.profiles[after["profileId"]]
        try:
            created = await self._runtimes.create_runtime(
                runtime.connectorId, runtime_type=runtime.runtimeType,
                name=f"{runtime.typeDisplayName}（{profile['name']}）"[:128],
                config=plan["config"], active=True, user_id=context.user_id,
                runtime_id=plan["reservedId"], managed_by=MANAGED_BY, fence=fence,
            )
        except DeviceRuntimeOfflineError:
            await self._store.save_channel_switch(*switch_row, {"step": VERIFYING})
            await self._wake.mark(*switch_row, context.user_id)
            return
        except DeviceRuntimeError as exc:
            await self._rollback(*switch_row, context.user_id, snapshot, reason="start_failed", message=exc.message)
            return
        await self._store.set_device_runtime_managed_by(runtime.connectorId, created.runtimeId, MANAGED_BY)
        ok, reason, message = await self._verify(created, plan, {})
        if not ok:
            await self._rollback(*switch_row, context.user_id, snapshot, reason=reason, message=message)
            return
        await self._commit(context, created, plan)

    async def _rollback(
        self, connector_id: str, runtime_id: str, user_id: str, snapshot: dict[str, Any], *,
        reason: str | None, message: str | None, resume_target: bool = False,
    ) -> None:
        """Put the snapshot back; ``restored`` when the runtime is as it was, else ``failed``."""
        await self._store.save_channel_switch(connector_id, runtime_id, {
            "state": RESTORING, "step": None, "reason": reason, "message": message,
            "leaseUntil": _iso(_now() + LEASE),
        })
        await self._publish(user_id)
        revision = await self._store.next_switch_revision(connector_id, runtime_id)
        fence = {"operationId": "restore_" + secrets.token_urlsafe(12), "switchRevision": revision}
        before = snapshot.get("before")
        target_id = snapshot.get("runtimeId")
        if before is None and target_id is not None and snapshot.get("created"):
            try:
                await self._runtimes._store.get_device_runtime(connector_id, target_id)
            except KeyError:
                target_id = None
            try:
                if target_id is not None:
                    async with self._runtimes.locked_runtime(connector_id, target_id, user_id=user_id) as handle:
                        await handle.set_active(False, fence=fence)
            except DeviceRuntimeError:
                await self._settle(connector_id, runtime_id, user_id, FAILED, reason="rollback_failed", keep_target=True)
                return
        if before is None or target_id is None:
            await self._settle(connector_id, runtime_id, user_id, PENDING if resume_target else RESTORED,
                reason=None if resume_target else reason, message=None if resume_target else message, keep_target=True)
            return
        try:
            async with self._runtimes.locked_runtime(connector_id, target_id, user_id=user_id) as handle:
                if before["config"] is not None and handle.runtime.config != before["config"]:
                    await handle.put_config(before["config"], restart=bool(before["active"]), fence=fence)
                if before["active"] and (not handle.runtime.active or handle.runtime.status not in RESTARTING_STATUSES):
                    if handle.runtime.active:
                        await handle.restart(fence=fence)
                    else:
                        await handle.set_active(True, fence=fence)
                elif not before["active"] and handle.runtime.active:
                    await handle.set_active(False, fence=fence)
                current = handle.runtime
            assignment = before.get("assignment")
            if assignment is not None:
                await self._store.save_runtime_assignment(_raw_assignment(assignment))
            elif await self._store.get_runtime_assignment(connector_id, target_id) is not None:
                await self._store.delete_runtime_assignment(connector_id, target_id)
            ok = True
            if before["active"]:
                ok, _, _ = await self._verify(current, {"config": before["config"], "active": True}, {})
        except DeviceRuntimeError as exc:
            logger.warning("model channel rollback failed connector_id={} runtime_id={} code={}",
                           connector_id, target_id, exc.code)
            ok = False
        async with self._store.channel_transaction(user_id):
            if ok and snapshot.get("previousChannel") is not None:
                await self._store.record_channel_observation(connector_id, runtime_id,
                    generation=snapshot.get("previousGeneration"), channel=snapshot["previousChannel"],
                    digest=connection_digest(before["config"], current.modelConnection or {}))
            outcome = PENDING if ok and resume_target else RESTORED if ok else FAILED
            await self._settle(connector_id, runtime_id, user_id, outcome,
                reason=None if outcome == PENDING else reason if ok else "rollback_failed",
                message=None if outcome == PENDING else message, keep_target=True, publish=False)
        await self._publish(user_id)

    async def _recover(self, switch: dict[str, Any], *, user_id: str) -> None:
        """Take over a switch whose worker stopped mid-way."""
        connector_id, runtime_id = switch["connectorId"], switch["runtimeId"]
        snapshot = None
        if switch["snapshotCiphertext"]:
            opened = self._box().open(switch["snapshotCiphertext"], context=f"channel-snapshot:{connector_id}:{runtime_id}")
            snapshot = json.loads(opened) if opened else None
        if snapshot is None or switch["step"] == PREPARING:
            # Nothing reached the runtime yet: start this switch over.
            await self._store.save_channel_switch(connector_id, runtime_id, {
                "state": PENDING, "step": None, "snapshotCiphertext": None,
            })
            return
        if switch["state"] == RESTORING:
            sync = await self._store.get_channel_sync(connector_id, runtime_id)
            resume_target = bool(sync and sync["next_retry_at"] and sync["next_retry_at"] <= utc_now())
            await self._rollback(connector_id, runtime_id, user_id, snapshot,
                                 reason=switch["reason"], message=switch["message"], resume_target=resume_target)
            return
        target_id = snapshot.get("runtimeId")
        after = snapshot.get("after")
        if target_id is None:
            await self._settle(connector_id, runtime_id, user_id, PENDING)
            return
        if not await self._runtimes.is_connector_online(connector_id):
            await self._wake.mark(connector_id, runtime_id, user_id)
            return  # verified when the device is back
        try:
            target = DeviceRuntimeView.model_validate(
                await self._runtimes._store.get_device_runtime(connector_id, target_id))
        except KeyError:
            if not snapshot.get("created"):
                raise
            base = await self._owned(connector_id, runtime_id, user_id=user_id)
            fence = {"operationId": switch["operationId"], "switchRevision": switch["switchRevision"]}
            target = await self._runtimes.create_runtime(connector_id, runtime_type=base.runtimeType,
                name=(base.typeDisplayName + " " + target_id)[-128:], config=snapshot["planConfig"],
                active=snapshot["planActive"], user_id=user_id, runtime_id=target_id, managed_by=MANAGED_BY, fence=fence)
        if snapshot.get("created"):
            await self._store.set_device_runtime_managed_by(connector_id, target_id, MANAGED_BY)
        plan = {"config": snapshot.get("planConfig", target.config), "active": snapshot.get("planActive", target.active), "after": after}
        expected = connection_digest(plan["config"], target.modelConnection or {})
        if connection_digest(target.config, target.modelConnection or {}) != expected:
            await self._rollback(connector_id, runtime_id, user_id, snapshot, reason="start_failed", message=None)
            return
        ok, reason, message = await self._verify(target, plan, {})
        if not ok:
            await self._rollback(connector_id, runtime_id, user_id, snapshot, reason=reason, message=message)
            return
        runtime = await self._owned(connector_id, runtime_id, user_id=user_id)
        context = await self._context(runtime, user_id=user_id)
        await self._commit(context, target, plan)

    async def _settle(
        self, connector_id: str, runtime_id: str, user_id: str, state: str, *,
        reason: str | None = None, message: str | None = None, target: str | None = None,
        keep_target: bool = False, publish: bool = True,
    ) -> None:
        sync = await self._store.get_channel_sync(connector_id, runtime_id)
        switch = await self._store.get_channel_switch(connector_id, runtime_id)
        generation = (switch or {}).get("targetGeneration")
        if state != FAILED and sync and generation is not None and generation != sync["desired_generation"]:
            state = PENDING
        if state in (RESTORED, FAILED, UNSUPPORTED):
            await self._store.channel_retry(connector_id, runtime_id, reason,
                automatic=reason in {"device_offline", "tokens_unavailable", "verify_timeout"})
        elif state == APPLIED:
            await self._store.channel_retry(connector_id, runtime_id, None)
        values: dict[str, Any] = {
            "targetGeneration": generation if generation is not None else (sync["desired_generation"] if sync else None),
            "userId": user_id, "state": state, "step": None, "reason": reason, "message": message,
            "snapshotCiphertext": None, "planCiphertext": None, "leaseUntil": None,
        }
        if state == FAILED:
            values.pop("snapshotCiphertext", None)
            values.pop("planCiphertext", None)
        if target is not None:
            values["targetChannel"] = target
        elif not keep_target and state != PENDING:
            values["targetChannel"] = None if state == APPLIED else values.get("targetChannel")
        await self._store.save_channel_switch(connector_id, runtime_id, values)
        if state == PENDING:
            await self._wake.mark(connector_id, runtime_id, user_id, sync["desired_generation"] if sync else 0)
        else:
            await self._wake.clear(connector_id, runtime_id, sync["desired_generation"] if sync else 0)
            for alias, (waiting, _) in (await self._wake.on_connector_raw(connector_id)).items():
                if waiting == runtime_id and alias != runtime_id:
                    await self._wake.clear(connector_id, alias)
        logger.info("channel reconciliation connector_id={} runtime_id={} target_generation={} desired_generation={} state={} reason={}",
                    connector_id, runtime_id, generation, sync["desired_generation"] if sync else None, state, reason)
        if publish:
            await self._publish(user_id)

    async def _wait_online(
        self, connector_id: str, runtime_id: str, user_id: str,
    ) -> None:
        await self._store.save_channel_switch(connector_id, runtime_id, {
            "userId": user_id, "state": WAITING_ONLINE, "step": None,
            "snapshotCiphertext": None, "leaseUntil": None,
        })
        await self._wake.mark(connector_id, runtime_id, user_id)
        await self._publish(user_id)

    # Reading one runtime.

    async def _context(self, runtime: DeviceRuntimeView, *, user_id: str) -> _Context:
        selection = await self.selection(user_id)
        overrides = {(o["connectorId"], o["runtimeId"]): o for o in await self._store.list_channel_overrides(user_id=user_id)}
        override = overrides.get((runtime.connectorId, runtime.runtimeId))
        profiles = {p["id"]: p for p in await self._store.list_model_profiles(user_id=user_id)}
        managed_id = managed_channel_runtime_id(runtime.connectorId, runtime.runtimeId)
        managed = None
        try:
            managed = DeviceRuntimeView.model_validate(
                await self._runtimes._store.get_device_runtime(runtime.connectorId, managed_id))
        except KeyError:
            if runtime.runtimeId == runtime.runtimeType:
                legacy_id = await self._store.find_managed_runtime_id(runtime.connectorId, runtime.runtimeType, MANAGED_BY, legacy_only=True)
                if legacy_id is not None:
                    managed = DeviceRuntimeView.model_validate(
                        await self._runtimes._store.get_device_runtime(runtime.connectorId, legacy_id))
        assignments = {}
        for item in (runtime, managed):
            if item is not None:
                found = await self._store.get_runtime_assignment(item.connectorId, item.runtimeId)
                if found is not None:
                    assignments[(item.connectorId, item.runtimeId)] = found
        actual, actual_target, assignment = _actual(runtime, managed, assignments, profiles)
        return _Context(
            user_id=user_id, runtime=runtime, managed=managed, override=override,
            desired=override["channel"] if override else selection["channel"],
            actual=actual, actual_target=actual_target, assignment=assignment, profiles=profiles,
        )

    async def _served_runtime(self, runtime: DeviceRuntimeView, *, user_id: str) -> DeviceRuntimeView | None:
        rows = await self._store.list_user_device_runtimes(user_id=user_id)
        candidates = [row for row in rows if row["connectorId"] == runtime.connectorId
                      and row["runtimeType"] == runtime.runtimeType and row.get("managedBy") != MANAGED_BY]
        for row in candidates:
            if managed_channel_runtime_id(runtime.connectorId, row["runtimeId"]) == runtime.runtimeId:
                return DeviceRuntimeView.model_validate(row)
        return next((DeviceRuntimeView.model_validate(row) for row in candidates
                     if row["runtimeId"] == row["runtimeType"]), None)

    async def _busy(self, runtime: DeviceRuntimeView, target: DeviceRuntimeView) -> bool:
        return await self._session_count(runtime, target) > 0

    async def _session_count(self, runtime: DeviceRuntimeView, target: DeviceRuntimeView) -> int:
        sessions = await self._store.list_running_sessions_for_connector_agent(
            connector_id=target.connectorId, runtime_id=target.runtimeId,
        )
        return len(sessions)

    async def _owned(self, connector_id: str, runtime_id: str, *, user_id: str) -> DeviceRuntimeView:
        try:
            return await self._runtimes.get_runtime(connector_id, runtime_id, user_id=user_id)
        except DeviceRuntimeError as exc:
            raise ModelConfigNotFoundError("runtime_not_found", "runtime not found") from exc

    async def _check_channel(self, channel: str, *, user_id: str) -> None:
        if channel == NATIVE:
            return
        profiles = await self._store.list_model_profiles(user_id=user_id)
        if channel == TOKENS:
            link = await self._store.get_tokens_link(user_id)
            if link is None or not any(p["source"] == "tokens" and p["state"] == "active" for p in profiles):
                raise ModelConfigConflictError("tokens_not_linked", "link Tokens Anywhere first")
            return
        profile = next((p for p in profiles if p["id"] == channel and p["source"] == "manual"), None)
        if profile is None:
            raise ModelConfigNotFoundError("channel_not_found", "no such channel")
        if profile["state"] != "active":
            raise ModelConfigConflictError("profile_detached", "this profile is detached")

    async def _respond(self, user_id: str) -> dict[str, Any]:
        await self.settle()
        await self._publish(user_id)
        return await self.state(user_id=user_id)

    def _box(self) -> SecretBox:
        try:
            return self._secret_box()
        except SecretBoxUnavailableError as exc:
            raise ModelConfigConflictError(exc.code, str(exc)) from exc

    async def _publish(self, user_id: str) -> None:
        if self._broker is None:
            return
        try:
            await self._broker.publish_dashboard(user_id, {"type": "dashboard.changed", "serverTime": utc_now()})
        except Exception:  # noqa: BLE001 - a missed push is recovered by the next one
            logger.exception("model channel dashboard publish failed user_id={}", user_id)


def _offers(profile: dict[str, Any]) -> list[Offer]:
    from agent_server.core.model_config import ModelPreferences

    raw = profile.get("preferences")
    preferences = ModelPreferences.model_validate(raw) if isinstance(raw, dict) else None
    return effective_offers([Offer.model_validate(offer) for offer in profile["offers"]], preferences)


def _channel_profile(channel: str, profiles: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    for profile in profiles.values():
        if profile["state"] == "active" and profile_channel(profile) == channel:
            return profile
    return None


def _actual(
    runtime: DeviceRuntimeView,
    managed: DeviceRuntimeView | None,
    assignments: dict[tuple[str, str], dict[str, Any]],
    profiles: dict[str, dict[str, Any]],
) -> tuple[str, DeviceRuntimeView, dict[str, Any] | None]:
    """The channel a runtime really uses, where it lives, and its assignment."""
    own = assignments.get((runtime.connectorId, runtime.runtimeId))
    if own is not None and own["profileId"] in profiles:
        return profile_channel(profiles[own["profileId"]]), runtime, own
    if managed is not None and managed.active:
        served = assignments.get((managed.connectorId, managed.runtimeId))
        if served is not None and served["profileId"] in profiles:
            return profile_channel(profiles[served["profileId"]]), managed, served
    return NATIVE, runtime, None


def _outdated(assignment: dict[str, Any], profiles: dict[str, dict[str, Any]]) -> bool:
    profile = profiles.get(assignment["profileId"])
    return profile is not None and profile["state"] == "active" and (
        assignment["appliedCatalogDigest"] != profile["catalogDigest"]
    )


def _assignment_values(
    connector_id: str, runtime_id: str, after: dict[str, Any], runtime: DeviceRuntimeView,
) -> dict[str, Any]:
    capability = runtime.modelConnection or {}
    return {
        "connector_id": connector_id,
        "runtime_id": runtime_id,
        "profile_id": after["profileId"],
        "offer_format": after["offerFormat"],
        "created_runtime": int(bool(after["createdRuntime"])),
        "applied_digest": written_digest(runtime.config, capability, after["importedModelIds"]),
        "applied_catalog_digest": after["catalogDigest"],
        "imported_model_ids": after["importedModelIds"],
        "previous_gateway_ciphertext": after["previousGatewayCiphertext"],
        "status": "applied",
        "error": None,
        "applied_at": utc_now(),
    }


def _raw_assignment(assignment: dict[str, Any]) -> dict[str, Any]:
    return {
        "connector_id": assignment["connectorId"],
        "runtime_id": assignment["runtimeId"],
        "profile_id": assignment["profileId"],
        "offer_format": assignment["offerFormat"],
        "created_runtime": int(bool(assignment["createdRuntime"])),
        "applied_digest": assignment["appliedDigest"],
        "applied_catalog_digest": assignment["appliedCatalogDigest"],
        "imported_model_ids": assignment["importedModelIds"],
        "previous_gateway_ciphertext": assignment["previousGatewayCiphertext"],
        "status": assignment["status"],
        "error": assignment.get("error"),
        "applied_at": assignment["appliedAt"],
    }
