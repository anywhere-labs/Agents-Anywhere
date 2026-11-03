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
LEASE = timedelta(minutes=10)
# Requests reaching a runtime wait this long for a switch before giving up.
ADMISSION_WAIT_SECONDS = 90.0
ADMISSION_TTL = timedelta(minutes=2)
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
        now: str,
    ) -> None: ...
    async def runtime_closed_for_switch(self, connector_id: str, runtime_ids: list[str], *, now: str) -> bool: ...
    async def list_user_device_runtimes(self, *, user_id: str) -> list[dict[str, Any]]: ...
    async def list_model_profiles(self, *, user_id: str) -> list[dict[str, Any]]: ...
    async def list_runtime_assignments(self, *, user_id: str) -> list[dict[str, Any]]: ...
    async def get_runtime_assignment(self, connector_id: str, runtime_id: str) -> dict[str, Any] | None: ...
    async def save_runtime_assignment(self, row: dict[str, Any]) -> None: ...
    async def delete_runtime_assignment(self, connector_id: str, runtime_id: str) -> None: ...
    async def set_device_runtime_managed_by(self, connector_id: str, runtime_id: str, managed_by: str | None) -> None: ...
    async def find_managed_runtime_id(self, connector_id: str, runtime_type: str, managed_by: str) -> str | None: ...
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

    async def mark(self, connector_id: str, runtime_id: str, user_id: str) -> None:
        if self._coordinator is not None:
            await self._coordinator.client.hset(self._key(connector_id), runtime_id, user_id)
            return
        self._local.setdefault(connector_id, {})[runtime_id] = user_id

    async def clear(self, connector_id: str, runtime_id: str) -> None:
        if self._coordinator is not None:
            await self._coordinator.client.hdel(self._key(connector_id), runtime_id)
            return
        self._local.get(connector_id, {}).pop(runtime_id, None)

    async def waiting(self, connector_id: str, runtime_id: str) -> tuple[str, str] | None:
        """The (runtime, user) waiting on events of ``runtime_id``: itself or the runtime it serves."""
        if self._coordinator is not None:
            value = await self._coordinator.client.hget(self._key(connector_id), runtime_id)
        else:
            value = self._local.get(connector_id, {}).get(runtime_id)
        return _parse_wait(runtime_id, value) if value else None

    async def on_connector_raw(self, connector_id: str) -> dict[str, tuple[str, str]]:
        """Every marked runtime of a device and the (runtime, user) it wakes."""
        if self._coordinator is not None:
            raw = dict(await self._coordinator.client.hgetall(self._key(connector_id)) or {})
        else:
            raw = dict(self._local.get(connector_id, {}))
        return {runtime_id: _parse_wait(runtime_id, value) for runtime_id, value in raw.items()}

    async def on_connector(self, connector_id: str) -> dict[str, str]:
        """Waiting runtimes of a device and their users (aliases resolved)."""
        if self._coordinator is not None:
            raw = dict(await self._coordinator.client.hgetall(self._key(connector_id)) or {})
        else:
            raw = dict(self._local.get(connector_id, {}))
        return dict(_parse_wait(runtime_id, value) for runtime_id, value in raw.items())


def _parse_wait(runtime_id: str, value: str) -> tuple[str, str]:
    """``user`` waits on the runtime itself; ``user<TAB>runtime`` on the runtime it serves."""
    user_id, _, served = value.partition("\t")
    return (served or runtime_id, user_id)


class ChannelDriver:
    """Runs at most one switch per runtime: one task in this process, one claim across workers."""

    def __init__(self, coordinator: RedisCoordinator | None, *, wait: bool = False) -> None:
        self._coordinator = coordinator if coordinator is not None and coordinator.distributed else None
        self._tasks: dict[tuple[str, str], asyncio.Task[None]] = {}
        # Tests (and single-request tools) finish switches before answering.
        self.wait = wait

    def running(self, connector_id: str, runtime_id: str) -> asyncio.Task[None] | None:
        task = self._tasks.get((connector_id, runtime_id))
        return task if task is not None and not task.done() else None

    def spawn(self, connector_id: str, runtime_id: str, work: Callable[[], Awaitable[None]]) -> asyncio.Task[None]:
        key = (connector_id, runtime_id)
        current = self.running(*key)
        if current is not None:
            return current

        async def run() -> None:
            token = secrets.token_urlsafe(12)
            claim_key = self._coordinator.key("channel-drive", *key) if self._coordinator else None
            if claim_key is not None and not await self._coordinator.claim(
                claim_key, token, ttl_seconds=LEASE.total_seconds()
            ):
                return  # another worker drives it
            try:
                await work()
            except Exception:  # noqa: BLE001 - the row keeps the state; the next event retries
                logger.exception("model channel switch failed connector_id={} runtime_id={}", *key)
            finally:
                if claim_key is not None:
                    await self._coordinator.delete_if_value(claim_key, token)

        task = asyncio.create_task(run(), name=f"channel-switch-{key[0]}-{key[1]}")
        self._tasks[key] = task
        task.add_done_callback(lambda _: self._tasks.pop(key, None) if self._tasks.get(key) is task else None)
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
        assignments = {(a["connectorId"], a["runtimeId"]): a for a in await self._store.list_runtime_assignments(user_id=user_id)}
        profiles = {p["id"]: p for p in await self._store.list_model_profiles(user_id=user_id)}
        managed = {(r.connectorId, r.runtimeType): r for r in runtimes if r.managedBy == MANAGED_BY}
        items = []
        for runtime in runtimes:
            if runtime.managedBy == MANAGED_BY or not runtime.modelConnection:
                continue
            key = (runtime.connectorId, runtime.runtimeId)
            override = overrides.get(key)
            desired = override["channel"] if override else selection["channel"]
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
        await self._check_channel(channel, user_id=user_id)
        await self._store.save_channel_selection(user_id, channel)
        # Applying a channel is an explicit immediate switch, including native.
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
        await self._store.set_channel_override(
            connector_id, runtime_id, channel, confirm_native_global=confirm_native_global
        )
        await self._store.save_channel_selection(user_id)
        await self._reset(connector_id, runtime_id, user_id=user_id)
        await self._plan(user_id, only=(connector_id, runtime_id))
        return await self._respond(user_id)

    async def retry(self, *, user_id: str, connector_id: str | None = None, runtime_id: str | None = None) -> dict[str, Any]:
        for switch in await self._store.list_channel_switches(user_id=user_id):
            if switch["state"] not in NEEDS_RETRY:
                continue
            if connector_id and (switch["connectorId"], switch["runtimeId"]) != (connector_id, runtime_id):
                continue
            await self._store.save_channel_switch(switch["connectorId"], switch["runtimeId"], {
                "userId": user_id, "state": PENDING, "reason": None, "message": None,
            })
            self._spawn(switch["connectorId"], switch["runtimeId"], user_id)
        return await self._respond(user_id)

    async def refresh(self, *, user_id: str, rewrite: str | None = None) -> bool:
        """Rewrite runtimes whose channel's models or key changed; True if any will be.

        ``rewrite`` names a channel whose runtimes are written again even if
        nothing they can compare changed, e.g. after its key was rotated.
        """
        await self._store.save_channel_selection(user_id)
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

    async def connector_event(self, connector_id: str) -> None:
        """The device is back: every runtime waiting on it may go on."""
        for runtime_id, user_id in (await self._wake.on_connector(connector_id)).items():
            self._spawn(connector_id, runtime_id, user_id)
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
        switch = await self._store.get_channel_switch(base.connectorId, base.runtimeId)
        if switch is not None and switch["state"] in (PENDING, WAITING_ONLINE, *IN_FLIGHT):
            task = self._spawn(base.connectorId, base.runtimeId, user_id)
            # Wait for configuration application, never for running tasks to end.
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=ADMISSION_WAIT_SECONDS)
            except TimeoutError:
                pass
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
        switches = {
            (item["connectorId"], item["runtimeId"])
            for item in await self._store.list_channel_switches(user_id=user_id)
        }
        created = False
        for row in await self._store.list_user_device_runtimes(user_id=user_id):
            runtime = DeviceRuntimeView.model_validate(row)
            key = (runtime.connectorId, runtime.runtimeId)
            if runtime.managedBy == MANAGED_BY or not runtime.modelConnection or key in switches:
                continue
            context = await self._context(runtime, user_id=user_id)
            if context.desired == context.actual and not (
                context.assignment is not None and _outdated(context.assignment, context.profiles)
            ):
                continue
            if await self._store.create_channel_switch_if_missing(*key, user_id=user_id):
                await self._wake.mark(*key, user_id)
                self._spawn(*key, user_id)
                created = True
        if created:
            await self._publish(user_id)
        await self.settle()

    async def _plan(
        self, user_id: str, *, only: tuple[str, str] | None = None,
        rewrite: str | None = None,
    ) -> bool:
        rows = await self._store.list_user_device_runtimes(user_id=user_id)
        moving = False
        for row in rows:
            runtime = DeviceRuntimeView.model_validate(row)
            if runtime.managedBy == MANAGED_BY or not runtime.modelConnection:
                continue
            if only is not None and (runtime.connectorId, runtime.runtimeId) != only:
                continue
            context = await self._context(runtime, user_id=user_id)
            switch = await self._store.get_channel_switch(runtime.connectorId, runtime.runtimeId)
            forced = rewrite is not None and context.actual == rewrite == context.desired
            due = forced or context.desired != context.actual or (
                context.assignment is not None and _outdated(context.assignment, context.profiles)
            )
            if not due:
                if switch is not None and switch["state"] not in IN_FLIGHT and switch["state"] != APPLIED:
                    await self._store.save_channel_switch(runtime.connectorId, runtime.runtimeId, {
                        "userId": user_id, "state": APPLIED, "step": None, "reason": None,
                        "message": None,
                    })
                    await self._wake.clear(runtime.connectorId, runtime.runtimeId)
                continue
            moving = True
            values: dict[str, Any] = {"userId": user_id, "startedAt": utc_now()}
            if switch is None or switch["state"] not in IN_FLIGHT:
                values.update(state=PENDING, step=None, reason=REWRITE if forced else None,
                              message=None)
            await self._store.save_channel_switch(runtime.connectorId, runtime.runtimeId, values)
            await self._wake.mark(runtime.connectorId, runtime.runtimeId, user_id)
            self._spawn(runtime.connectorId, runtime.runtimeId, user_id)
        await self._publish(user_id)
        return moving

    async def _reset(self, connector_id: str, runtime_id: str, *, user_id: str) -> None:
        switch = await self._store.get_channel_switch(connector_id, runtime_id)
        if switch is not None and switch["state"] in NEEDS_RETRY:
            await self._store.save_channel_switch(connector_id, runtime_id, {
                "userId": user_id, "state": PENDING, "reason": None, "message": None,
            })

    def _spawn(self, connector_id: str, runtime_id: str, user_id: str) -> asyncio.Task[None]:
        task = self._driver.spawn(connector_id, runtime_id, lambda: self._drive(connector_id, runtime_id, user_id))
        if task is not asyncio.current_task():
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
            context = await self._context(runtime, user_id=user_id)
            outdated = context.assignment is not None and (
                _outdated(context.assignment, context.profiles)
                or (switch["reason"] == REWRITE and switch["state"] in (PENDING, WAITING_ONLINE))
            )
            if context.desired == context.actual and not outdated:
                await self._settle(connector_id, runtime_id, user_id, APPLIED)
                return
            if switch["state"] in NEEDS_RETRY and switch["targetChannel"] == context.desired:
                return  # failed before; waits for the user to retry
            reason = self._unsupported(context)
            if reason is not None:
                await self._settle(connector_id, runtime_id, user_id, UNSUPPORTED, reason=reason)
                return
            target = context.actual_target if context.desired == NATIVE else (context.managed if self._needs_managed(context) else context.runtime)
            if target is not None and not await self._runtimes.is_connector_online(connector_id):
                await self._wait_online(connector_id, runtime_id, user_id)
                return
            await self._execute(context, switch)
            # The wanted channel may have changed while this one ran.

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
        revision = await self._store.next_switch_revision(connector_id, runtime_id)
        box = self._box()
        target = plan["target"]
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
        }
        sealed = box.seal(json.dumps(snapshot), context=f"channel-snapshot:{connector_id}:{runtime_id}")
        await self._store.save_channel_switch(connector_id, runtime_id, {
            "userId": context.user_id, "state": SWITCHING, "step": PREPARING, "targetChannel": context.desired,
            "operationId": operation_id, "snapshotCiphertext": sealed, "reason": None, "message": None,
            "leaseUntil": _iso(_now() + LEASE), "startedAt": switch.get("startedAt") or utc_now(),
        })
        await self._publish(context.user_id)
        fence = {"operationId": operation_id, "switchRevision": revision}
        if target is None:
            # A managed instance is created for this channel: nothing existing to roll back.
            await self._create_managed(context, plan, switch_row=(connector_id, runtime_id), fence=fence)
            return
        # Close the runtime to new tasks, then make sure none slipped in.
        await self._store.close_runtime_for_switch(
            connector_id, runtime_id,
            {"step": ACTIVATING, "leaseUntil": _iso(_now() + LEASE)},
            now=_iso(_now()),
        )
        await self._publish(context.user_id)
        ok, reason, message = await self._activate(context, target, plan, fence)
        if ok:
            await self._commit(context, target, plan)
            return
        if reason == OFFLINE:
            await self._store.save_channel_switch(connector_id, runtime_id, {
                "step": VERIFYING, "leaseUntil": _iso(_now()),
            })
            await self._wake.mark(connector_id, runtime_id, context.user_id)
            await self._publish(context.user_id)
            return
        await self._rollback(connector_id, runtime_id, context.user_id, snapshot, reason=reason, message=message)

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
                if plan["config"] != handle.runtime.config or (plan["active"] and handle.runtime.active):
                    # A switch always rebuilds a running instance from the full
                    # target config, even when the saved config is unchanged.
                    await handle.put_config(plan["config"], restart=True, fence=fence)
                if plan["active"] and not handle.runtime.active:
                    await handle.set_active(True, fence=fence)
                elif not plan["active"] and handle.runtime.active:
                    await handle.set_active(False)
                started = dict(handle.last_start)
        except DeviceRuntimeInvalidConfigError as exc:
            return False, "validate_failed", exc.message
        except DeviceRuntimeOfflineError:
            # Whether the new config started is unknown until the device is back.
            return False, OFFLINE, None
        except DeviceRuntimeError as exc:
            code = exc.detail.get("code") if isinstance(exc.detail, dict) else None
            # A newer switch already reached the Connector.
            return False, "superseded" if code == "switch_revision_stale" else "start_failed", exc.message
        except TimeoutError:
            # The Connector may have started it anyway: verify asks what it runs.
            started = {}
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
            if row.status == "error":
                message = (row.error or {}).get("message") if isinstance(row.error, dict) else None
                return False, "start_failed", message
            if row.status == "running" and connection_digest(row.config, capability) == expected:
                report = row.modelConnectionReport
                if expected is None or report is None:
                    # Older Connectors report nothing beyond running the saved config.
                    return True, None, None
                status = (public_runtime_view(row).modelConnectionStatus or {}).get("state")
                if status in {"applied", "managed_externally"}:
                    return True, None, None
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
        await self._settle(connector_id, runtime_id, context.user_id, APPLIED)

    async def _create_managed(
        self, context: _Context, plan: dict[str, Any], *, switch_row: tuple[str, str], fence: dict[str, Any],
    ) -> None:
        runtime = context.runtime
        after = plan["after"]
        profile = context.profiles[after["profileId"]]
        try:
            created = await self._runtimes.create_runtime(
                runtime.connectorId, runtime_type=runtime.runtimeType,
                name=f"{runtime.typeDisplayName}（{profile['name']}）"[:128],
                config=plan["config"], active=True, user_id=context.user_id,
            )
        except DeviceRuntimeError as exc:
            await self._settle(*switch_row, context.user_id, RESTORED, reason="start_failed",
                               message=exc.message, target=context.desired)
            return
        await self._store.set_device_runtime_managed_by(runtime.connectorId, created.runtimeId, MANAGED_BY)
        ok, reason, message = await self._verify(created, plan, {})
        if not ok:
            # The runtime it serves was never touched; the new instance just stops.
            try:
                async with self._runtimes.locked_runtime(runtime.connectorId, created.runtimeId, user_id=context.user_id) as handle:
                    await handle.set_active(False)
            except DeviceRuntimeError:
                logger.warning("could not stop a managed instance that failed to start runtime_id={}", created.runtimeId)
            await self._settle(*switch_row, context.user_id, RESTORED, reason=reason, message=message, target=context.desired)
            return
        await self._store.save_runtime_assignment(_assignment_values(runtime.connectorId, created.runtimeId, after, created))
        await self._settle(*switch_row, context.user_id, APPLIED)

    async def _rollback(
        self, connector_id: str, runtime_id: str, user_id: str, snapshot: dict[str, Any], *,
        reason: str | None, message: str | None,
    ) -> None:
        """Put the snapshot back; ``restored`` when the runtime is as it was, else ``failed``."""
        await self._store.save_channel_switch(connector_id, runtime_id, {
            "state": RESTORING, "step": None, "reason": reason, "message": message,
            "leaseUntil": _iso(_now() + LEASE),
        })
        await self._publish(user_id)
        before = snapshot.get("before")
        target_id = snapshot.get("runtimeId")
        if before is None or target_id is None:
            await self._settle(connector_id, runtime_id, user_id, RESTORED, reason=reason, message=message, keep_target=True)
            return
        try:
            async with self._runtimes.locked_runtime(connector_id, target_id, user_id=user_id) as handle:
                if before["config"] is not None and handle.runtime.config != before["config"]:
                    await handle.put_config(before["config"], restart=bool(before["active"]))
                if before["active"] and (not handle.runtime.active or handle.runtime.status not in RESTARTING_STATUSES):
                    if handle.runtime.active:
                        await handle.restart()
                    else:
                        await handle.set_active(True)
                elif not before["active"] and handle.runtime.active:
                    await handle.set_active(False)
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
        await self._settle(connector_id, runtime_id, user_id, RESTORED if ok else FAILED,
                           reason=reason if ok else "rollback_failed", message=message, keep_target=True)

    async def _recover(self, switch: dict[str, Any], *, user_id: str) -> None:
        """Take over a switch whose worker stopped mid-way."""
        connector_id, runtime_id = switch["connectorId"], switch["runtimeId"]
        owned_elsewhere = self._driver.running(connector_id, runtime_id) is not asyncio.current_task()
        if switch["leaseUntil"] and switch["leaseUntil"] > _iso(_now()) and owned_elsewhere:
            return  # still owned; its own task finishes it
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
            await self._rollback(connector_id, runtime_id, user_id, snapshot,
                                 reason=switch["reason"], message=switch["message"])
            return
        target_id = snapshot.get("runtimeId")
        after = snapshot.get("after")
        if target_id is None:
            await self._settle(connector_id, runtime_id, user_id, PENDING)
            return
        if not await self._runtimes.is_connector_online(connector_id):
            await self._wake.mark(connector_id, runtime_id, user_id)
            return  # verified when the device is back
        target = DeviceRuntimeView.model_validate(
            await self._runtimes._store.get_device_runtime(connector_id, target_id)
        )
        plan = {"config": target.config, "active": target.active, "after": after}
        expected = after["digest"] if after else connection_digest(snapshot["before"]["config"], target.modelConnection or {})
        if after is not None and connection_digest(target.config, target.modelConnection or {}) != expected:
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
        keep_target: bool = False,
    ) -> None:
        values: dict[str, Any] = {
            "userId": user_id, "state": state, "step": None, "reason": reason, "message": message,
            "snapshotCiphertext": None, "leaseUntil": None,
        }
        if target is not None:
            values["targetChannel"] = target
        elif not keep_target and state != PENDING:
            values["targetChannel"] = None if state == APPLIED else values.get("targetChannel")
        await self._store.save_channel_switch(connector_id, runtime_id, values)
        if state == PENDING:
            await self._wake.mark(connector_id, runtime_id, user_id)
        else:
            await self._wake.clear(connector_id, runtime_id)
            for alias, (waiting, _) in (await self._wake.on_connector_raw(connector_id)).items():
                if waiting == runtime_id and alias != runtime_id:
                    await self._wake.clear(connector_id, alias)
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
        managed_id = await self._store.find_managed_runtime_id(runtime.connectorId, runtime.runtimeType, MANAGED_BY)
        managed = None
        if managed_id is not None:
            managed = DeviceRuntimeView.model_validate(
                await self._runtimes._store.get_device_runtime(runtime.connectorId, managed_id)
            )
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
        for row in await self._store.list_user_device_runtimes(user_id=user_id):
            if (row["connectorId"] == runtime.connectorId and row["runtimeType"] == runtime.runtimeType
                    and row.get("managedBy") != MANAGED_BY):
                return DeviceRuntimeView.model_validate(row)
        return None

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
