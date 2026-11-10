"""Durable desired state, transactional notifications and execution ownership."""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from contextvars import ContextVar
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import and_, delete, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from agent_server.core.model_channel import managed_channel_runtime_id
from agent_server.core.utc import utc_now
from agent_server.infra.db.engine import closing_connection
from agent_server.infra.db.schema import (
    channel_device_fences,
    channel_device_gates,
    channel_rotation_intents,
    channel_sync_outbox,
    connectors,
    device_runtimes,
    model_profiles,
    runtime_channel_switches,
    runtime_channel_sync,
)

_transaction: ContextVar[Any] = ContextVar("channel_transaction", default=None)
_claim: ContextVar[Any] = ContextVar("channel_claim", default=None)


class ChannelLeaseLost(RuntimeError):
    pass


def deadline(seconds: float) -> str:
    return (
        (datetime.now(UTC) + timedelta(seconds=seconds))
        .isoformat()
        .replace("+00:00", "Z")
    )


@asynccontextmanager
async def channel_connection(store: Any, *, write: bool = False) -> AsyncIterator[Any]:
    current = _transaction.get()
    if current is not None and current[:2] == (store, asyncio.current_task()):
        yield current[2]
        return
    async with closing_connection(store._engine, write=write) as conn:
        claim = _claim.get()
        if write and claim is not None and claim[0] is store:
            _, connector_id, runtime_id, owner, epoch = claim
            user_id = (
                await conn.execute(
                    select(connectors.c.user_id).where(connectors.c.id == connector_id)
                )
            ).scalar_one()
            await conn.execute(
                select(
                    func.pg_advisory_xact_lock(
                        func.hashtextextended("channel-user:" + user_id, 0)
                    )
                )
            )
            row = (
                await conn.execute(
                    select(runtime_channel_switches.c.lease_owner)
                    .where(
                        runtime_channel_switches.c.connector_id == connector_id,
                        runtime_channel_switches.c.runtime_id == runtime_id,
                        runtime_channel_switches.c.lease_owner == owner,
                        runtime_channel_switches.c.lease_epoch == epoch,
                        runtime_channel_switches.c.lease_until > utc_now(),
                    )
                    .with_for_update()
                )
            ).first()
            if row is None:
                raise ChannelLeaseLost("channel execution ownership expired")
        token = _transaction.set((store, asyncio.current_task(), conn))
        try:
            yield conn
        finally:
            _transaction.reset(token)


class ChannelReconciliationRepositoryMixin:
    @asynccontextmanager
    async def channel_transaction(self, user_id: str) -> AsyncIterator[None]:
        async with channel_connection(self, write=True) as conn:
            await conn.execute(
                select(
                    func.pg_advisory_xact_lock(
                        func.hashtextextended("channel-user:" + user_id, 0)
                    )
                )
            )
            yield

    async def refresh_channel_targets(self, user_id: str) -> None:
        async with self.channel_transaction(user_id):
            await self._refresh_channel_targets(user_id)

    async def _refresh_channel_targets(self, user_id: str) -> None:
        async with channel_connection(self, write=True) as conn:
            selection = await self.get_channel_selection(user_id)
            # Preserve pre-channel migration selection semantics.
            if selection is None:
                return
            overrides = {
                (x["connectorId"], x["runtimeId"]): x
                for x in await self.list_channel_overrides(user_id=user_id)
            }
            profiles = await self.list_model_profiles(user_id=user_id)
            by_channel = {
                ("tokens" if p["source"] == "tokens" else p["id"]): p for p in profiles
            }
            rows = await self.list_user_device_runtimes(user_id=user_id)
            # Older stored managed instances may have lost their owner marker.
            # Their reserved ID still identifies the logical runtime they serve;
            # do not schedule a second switch against the same physical instance.
            managed_ids = {
                (row["connectorId"], managed_channel_runtime_id(row["connectorId"], row["runtimeId"]), row["runtimeType"])
                for row in rows
                if row.get("managedBy") != "model-config" and not row["runtimeId"].startswith("rti_channel_")
            }
            for row in rows:
                if (row["connectorId"], row["runtimeId"], row["runtimeType"]) in managed_ids and row.get("managedBy") is None:
                    await conn.execute(update(device_runtimes).where(
                        device_runtimes.c.connector_id == row["connectorId"],
                        device_runtimes.c.runtime_id == row["runtimeId"],
                        device_runtimes.c.managed_by.is_(None),
                    ).values(managed_by="model-config"))
                    row["managedBy"] = "model-config"
            changed_devices = set()
            for runtime in sorted(
                rows, key=lambda x: (x["connectorId"], x["runtimeId"])
            ):
                if runtime.get("managedBy") == "model-config" or not runtime.get(
                    "modelConnection"
                ):
                    continue
                key = (runtime["connectorId"], runtime["runtimeId"])
                override = overrides.get(key)
                channel = override["channel"] if override else selection["channel"]
                profile = by_channel.get(channel) if channel != "native" else None
                material = {
                    "channel": channel,
                    "connectionRevision": profile["connectionRevision"]
                    if profile
                    else None,
                    "catalogDigest": profile["catalogDigest"] if profile else None,
                    "profileState": profile["state"] if profile else None,
                    "capability": runtime["modelConnection"],
                    "confirmed": bool(override and override.get("confirmNativeGlobal")),
                }
                digest = hashlib.sha256(
                    json.dumps(material, sort_keys=True, separators=(",", ":")).encode()
                ).hexdigest()
                statement = pg_insert(runtime_channel_sync).values(
                    connector_id=key[0],
                    runtime_id=key[1],
                    user_id=user_id,
                    desired_generation=1,
                    desired_channel=channel,
                    desired_spec_digest=digest,
                    updated_at=utc_now(),
                )
                result = await conn.execute(
                    statement.on_conflict_do_update(
                        index_elements=["connector_id", "runtime_id"],
                        set_={
                            "desired_generation": runtime_channel_sync.c.desired_generation
                            + 1,
                            "desired_channel": channel,
                            "desired_spec_digest": digest,
                            "retry_count": 0,
                            "next_retry_at": None,
                            "last_error_code": None,
                            "last_error_at": None,
                            "updated_at": utc_now(),
                        },
                        where=runtime_channel_sync.c.desired_spec_digest != digest,
                    ).returning(runtime_channel_sync.c.connector_id)
                )
                if result.first() is not None:
                    changed_devices.add(key[0])
            for connector_id in changed_devices:
                await self.enqueue_channel_sync(user_id, connector_id)

    async def enqueue_channel_sync(self, user_id: str, connector_id: str) -> None:
        async with channel_connection(self, write=True) as conn:
            await conn.execute(
                channel_sync_outbox.insert().values(
                    id=secrets.token_urlsafe(18),
                    user_id=user_id,
                    connector_id=connector_id,
                    created_at=utc_now(),
                    next_attempt_at=utc_now(),
                )
            )

    async def get_channel_sync(
        self, connector_id: str, runtime_id: str
    ) -> dict[str, Any] | None:
        async with channel_connection(self) as conn:
            row = (
                (
                    await conn.execute(
                        select(runtime_channel_sync).where(
                            runtime_channel_sync.c.connector_id == connector_id,
                            runtime_channel_sync.c.runtime_id == runtime_id,
                        )
                    )
                )
                .mappings()
                .first()
            )
        return dict(row) if row else None

    async def list_channel_sync(self, user_id: str) -> list[dict[str, Any]]:
        async with channel_connection(self) as conn:
            return [
                dict(x)
                for x in (
                    await conn.execute(
                        select(runtime_channel_sync).where(
                            runtime_channel_sync.c.user_id == user_id
                        )
                    )
                ).mappings()
            ]

    async def record_channel_observation(
        self,
        connector_id: str,
        runtime_id: str,
        *,
        generation: int | None,
        channel: str,
        digest: str | None,
        instance_id: str | None = None,
    ) -> None:
        async with channel_connection(self, write=True) as conn:
            await conn.execute(
                update(runtime_channel_sync)
                .where(
                    runtime_channel_sync.c.connector_id == connector_id,
                    runtime_channel_sync.c.runtime_id == runtime_id,
                )
                .values(
                    applied_generation=generation,
                    actual_channel=channel,
                    actual_config_digest=digest,
                    observed_instance_id=instance_id,
                    observed_at=utc_now(),
                    updated_at=utc_now(),
                )
            )

    async def channel_retry(
        self,
        connector_id: str,
        runtime_id: str,
        error: str | None,
        *,
        automatic: bool = False,
    ) -> None:
        async with channel_connection(self, write=True) as conn:
            row = await self.get_channel_sync(connector_id, runtime_id)
            if row is None:
                return
            count = row["retry_count"] + 1 if error else 0
            import random

            when = (
                deadline(min(120, 2 ** min(count, 7) * random.uniform(0.8, 1.2)))
                if automatic
                else None
            )
            await conn.execute(
                update(runtime_channel_sync)
                .where(
                    runtime_channel_sync.c.connector_id == connector_id,
                    runtime_channel_sync.c.runtime_id == runtime_id,
                )
                .values(
                    retry_count=count,
                    next_retry_at=when,
                    last_error_code=error,
                    last_error_at=utc_now() if error else None,
                    updated_at=utc_now(),
                )
            )

    async def claim_channel_execution(
        self, connector_id: str, runtime_id: str, owner: str
    ) -> int | None:
        async with channel_connection(self, write=True) as conn:
            epoch = (
                await conn.execute(
                    update(runtime_channel_switches)
                    .where(
                        runtime_channel_switches.c.connector_id == connector_id,
                        runtime_channel_switches.c.runtime_id == runtime_id,
                        or_(
                            runtime_channel_switches.c.lease_owner.is_(None),
                            runtime_channel_switches.c.lease_until.is_(None),
                            runtime_channel_switches.c.lease_until <= utc_now(),
                        ),
                    )
                    .values(
                        lease_owner=owner,
                        lease_epoch=runtime_channel_switches.c.lease_epoch + 1,
                        lease_until=deadline(60),
                    )
                    .returning(runtime_channel_switches.c.lease_epoch)
                )
            ).scalar_one_or_none()
        return epoch

    async def renew_channel_execution(
        self,
        connector_id: str,
        runtime_id: str,
        owner: str,
        epoch: int,
        *,
        release: bool = False,
    ) -> bool:
        # Renewal runs in another task and must not inherit a transaction or execution guard.
        async with closing_connection(self._engine, write=True) as conn:
            result = await conn.execute(
                update(runtime_channel_switches)
                .where(
                    runtime_channel_switches.c.connector_id == connector_id,
                    runtime_channel_switches.c.runtime_id == runtime_id,
                    runtime_channel_switches.c.lease_owner == owner,
                    runtime_channel_switches.c.lease_epoch == epoch,
                    runtime_channel_switches.c.lease_until > utc_now(),
                )
                .values(
                    lease_owner=None if release else owner,
                    lease_until=None if release else deadline(60),
                )
            )
        return bool(result.rowcount)

    @asynccontextmanager
    async def channel_execution(
        self, connector_id: str, runtime_id: str, owner: str, epoch: int
    ) -> AsyncIterator[None]:
        token = _claim.set((self, connector_id, runtime_id, owner, epoch))
        try:
            yield
        finally:
            _claim.reset(token)

    async def assert_channel_execution(self) -> None:
        async with channel_connection(self, write=True):
            pass

    async def next_device_channel_revision(self, connector_id: str) -> int:
        async with channel_connection(self, write=True) as conn:
            statement = pg_insert(channel_device_fences).values(
                connector_id=connector_id, revision=1
            )
            return int(
                (
                    await conn.execute(
                        statement.on_conflict_do_update(
                            index_elements=["connector_id"],
                            set_={"revision": channel_device_fences.c.revision + 1},
                        ).returning(channel_device_fences.c.revision)
                    )
                ).scalar_one()
            )

    async def claim_channel_notifications(self, owner: str) -> list[dict[str, Any]]:
        async with channel_connection(self, write=True) as conn:
            rows = (
                (
                    await conn.execute(
                        select(channel_sync_outbox)
                        .where(
                            channel_sync_outbox.c.delivered_at.is_(None),
                            channel_sync_outbox.c.next_attempt_at <= utc_now(),
                            or_(
                                channel_sync_outbox.c.claim_until.is_(None),
                                channel_sync_outbox.c.claim_until <= utc_now(),
                            ),
                        )
                        .order_by(channel_sync_outbox.c.created_at)
                        .limit(100)
                        .with_for_update(skip_locked=True)
                    )
                )
                .mappings()
                .all()
            )
            if rows:
                await conn.execute(
                    update(channel_sync_outbox)
                    .where(channel_sync_outbox.c.id.in_([x["id"] for x in rows]))
                    .values(
                        claim_owner=owner,
                        claim_until=deadline(30),
                        attempts=channel_sync_outbox.c.attempts + 1,
                    )
                )
            return [dict(x) for x in rows]

    async def finish_channel_notification(
        self, notification_id: str, owner: str, *, success: bool
    ) -> None:
        async with channel_connection(self, write=True) as conn:
            await conn.execute(
                update(channel_sync_outbox)
                .where(
                    channel_sync_outbox.c.id == notification_id,
                    channel_sync_outbox.c.claim_owner == owner,
                    channel_sync_outbox.c.claim_until > utc_now(),
                )
                .values(
                    delivered_at=utc_now() if success else None,
                    claim_owner=None,
                    claim_until=None,
                    next_attempt_at=deadline(5),
                )
            )

    async def channel_due_devices(
        self, *, after: str = "", limit: int = 100, full: bool = False
    ) -> list[dict[str, Any]]:
        async with channel_connection(self) as conn:
            return [
                dict(x)
                for x in (
                    await conn.execute(
                        select(connectors.c.id, connectors.c.user_id)
                        .where(
                            connectors.c.id > after,
                            connectors.c.revoked == 0,
                            True
                            if full
                            else select(runtime_channel_sync.c.runtime_id)
                            .where(
                                runtime_channel_sync.c.connector_id == connectors.c.id,
                                or_(
                                    runtime_channel_sync.c.applied_generation.is_distinct_from(
                                        runtime_channel_sync.c.desired_generation
                                    ),
                                    select(runtime_channel_switches.c.runtime_id)
                                    .where(
                                        runtime_channel_switches.c.connector_id
                                        == runtime_channel_sync.c.connector_id,
                                        runtime_channel_switches.c.runtime_id
                                        == runtime_channel_sync.c.runtime_id,
                                        runtime_channel_switches.c.state.in_(
                                            ("pending", "switching", "restoring")
                                        ),
                                    )
                                    .correlate(runtime_channel_sync)
                                    .exists(),
                                ),
                                or_(
                                    runtime_channel_sync.c.next_retry_at.is_(None),
                                    runtime_channel_sync.c.next_retry_at <= utc_now(),
                                ),
                            )
                            .exists(),
                        )
                        .order_by(connectors.c.id)
                        .limit(limit)
                    )
                ).mappings()
            ]

    async def prune_channel_notifications(self) -> None:
        async with channel_connection(self, write=True) as conn:
            await conn.execute(
                delete(channel_sync_outbox).where(
                    channel_sync_outbox.c.delivered_at < deadline(-7 * 86400)
                )
            )

    async def save_rotation_intent(
        self, user_id: str, profile_id: str, key_id: str, state: str
    ) -> None:
        async with channel_connection(self, write=True) as conn:
            statement = pg_insert(channel_rotation_intents).values(
                user_id=user_id,
                profile_id=profile_id,
                key_id=key_id,
                state=state,
                updated_at=utc_now(),
            )
            await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=["user_id"],
                    set_={
                        k: statement.excluded[k]
                        for k in ("profile_id", "key_id", "state", "updated_at")
                    },
                )
            )

    async def pending_rotation_intents(self) -> list[dict[str, Any]]:
        async with channel_connection(self) as conn:
            return [
                dict(x)
                for x in (
                    await conn.execute(
                        select(channel_rotation_intents).where(
                            or_(
                                channel_rotation_intents.c.state == "uncertain",
                                and_(
                                    channel_rotation_intents.c.state == "pending",
                                    channel_rotation_intents.c.updated_at
                                    < deadline(-120),
                                ),
                            )
                        )
                    )
                ).mappings()
            ]

    async def channel_connector_owner(self, connector_id: str) -> str | None:
        async with channel_connection(self) as conn:
            return (
                await conn.execute(
                    select(connectors.c.user_id).where(
                        connectors.c.id == connector_id, connectors.c.revoked == 0
                    )
                )
            ).scalar_one_or_none()

    async def bump_channel_connection(self, user_id: str, channel: str) -> None:
        async with channel_connection(self, write=True) as conn:
            condition = (
                model_profiles.c.source == "tokens"
                if channel == "tokens"
                else model_profiles.c.id == channel
            )
            await conn.execute(
                update(model_profiles)
                .where(model_profiles.c.user_id == user_id, condition)
                .values(connection_revision=model_profiles.c.connection_revision + 1)
            )

    async def set_channel_device_gate(
        self, connector_id: str, connection_id: str
    ) -> None:
        async with channel_connection(self, write=True) as conn:
            statement = pg_insert(channel_device_gates).values(
                connector_id=connector_id,
                connection_id=connection_id,
                expires_at=deadline(180),
            )
            await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=["connector_id"],
                    set_={"connection_id": connection_id, "expires_at": deadline(180)},
                )
            )

    async def clear_channel_device_gate(
        self, connector_id: str, connection_id: str
    ) -> None:
        async with channel_connection(self, write=True) as conn:
            await conn.execute(
                delete(channel_device_gates).where(
                    channel_device_gates.c.connector_id == connector_id,
                    channel_device_gates.c.connection_id == connection_id,
                )
            )

    async def channel_admission_blocked(
        self, connector_id: str, runtime_ids: list[str], conn: Any, now: str
    ) -> bool:
        gate = (
            await conn.execute(
                select(channel_device_gates.c.connector_id)
                .join(
                    connectors, connectors.c.id == channel_device_gates.c.connector_id
                )
                .where(
                    channel_device_gates.c.connector_id == connector_id,
                    channel_device_gates.c.connection_id
                    == connectors.c.presence_connection_id,
                    channel_device_gates.c.expires_at > now,
                )
            )
        ).first()
        if gate is not None:
            return True
        rows = (
            (
                await conn.execute(
                    select(
                        runtime_channel_sync,
                        runtime_channel_switches.c.state,
                        runtime_channel_switches.c.target_generation,
                    )
                    .outerjoin(
                        runtime_channel_switches,
                        and_(
                            runtime_channel_switches.c.connector_id
                            == runtime_channel_sync.c.connector_id,
                            runtime_channel_switches.c.runtime_id
                            == runtime_channel_sync.c.runtime_id,
                        ),
                    )
                    .where(
                        runtime_channel_sync.c.connector_id == connector_id,
                        runtime_channel_sync.c.runtime_id.in_(runtime_ids),
                    )
                )
            )
            .mappings()
            .all()
        )
        for row in rows:
            if row["state"] == "failed":
                return True
            if row["desired_generation"] != row["applied_generation"]:
                # Restored/unsupported may use the last usable channel for this target.
                if (
                    row["state"] in {"restored", "unsupported"}
                    and row["target_generation"] == row["desired_generation"]
                ):
                    continue
                return True
        return False

    async def begin_channel_rotation(
        self, user_id: str, profile_id: str, key_id: str
    ) -> bool:
        async with channel_connection(self, write=True) as conn:
            statement = pg_insert(channel_rotation_intents).values(
                user_id=user_id,
                profile_id=profile_id,
                key_id=key_id,
                state="pending",
                updated_at=utc_now(),
            )
            row = (
                await conn.execute(
                    statement.on_conflict_do_update(
                        index_elements=["user_id"],
                        set_={
                            "profile_id": profile_id,
                            "key_id": key_id,
                            "state": "pending",
                            "updated_at": utc_now(),
                        },
                        where=channel_rotation_intents.c.state == "confirmed",
                    ).returning(channel_rotation_intents.c.user_id)
                )
            ).first()
        return row is not None

    async def channel_discovery_gated(self, connector_id: str) -> bool:
        async with channel_connection(self) as conn:
            return (
                await conn.execute(
                    select(channel_device_gates.c.connector_id)
                    .join(
                        connectors,
                        connectors.c.id == channel_device_gates.c.connector_id,
                    )
                    .where(
                        channel_device_gates.c.connector_id == connector_id,
                        channel_device_gates.c.connection_id
                        == connectors.c.presence_connection_id,
                        channel_device_gates.c.expires_at > utc_now(),
                    )
                )
            ).first() is not None

    async def channel_statistics(self) -> dict[str, Any]:
        async with channel_connection(self) as conn:
            pending = (
                await conn.execute(
                    select(
                        func.count(), func.min(runtime_channel_sync.c.updated_at)
                    ).where(
                        runtime_channel_sync.c.applied_generation.is_distinct_from(
                            runtime_channel_sync.c.desired_generation
                        )
                    )
                )
            ).one()
            notifications = (
                await conn.execute(
                    select(
                        func.count(), func.min(channel_sync_outbox.c.created_at)
                    ).where(channel_sync_outbox.c.delivered_at.is_(None))
                )
            ).one()
            failures = (
                await conn.execute(
                    select(func.count())
                    .select_from(runtime_channel_switches)
                    .where(runtime_channel_switches.c.state == "failed")
                )
            ).scalar_one()
        return {
            "pending": pending[0],
            "oldestPendingUpdate": pending[1],
            "outboxPending": notifications[0],
            "oldestNotification": notifications[1],
            "failed": failures,
        }

    async def plan_channel_switch(
        self, connector_id: str, runtime_id: str, values: dict[str, Any]
    ) -> None:
        # Never overwrite a phase written after the planner's earlier read.
        columns = {
            "user_id": values["userId"],
            "started_at": values["startedAt"],
            "updated_at": utc_now(),
            "target_generation": values.get("targetGeneration"),
            "state": values.get("state", "pending"),
            "step": values.get("step"),
            "reason": values.get("reason"),
            "message": values.get("message"),
        }
        async with channel_connection(self, write=True) as conn:
            statement = pg_insert(runtime_channel_switches).values(
                connector_id=connector_id, runtime_id=runtime_id, **columns
            )
            await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=["connector_id", "runtime_id"],
                    set_={k: statement.excluded[k] for k in columns},
                    where=and_(
                        runtime_channel_switches.c.state.not_in(
                            ("switching", "restoring")
                        ),
                        or_(
                            runtime_channel_switches.c.lease_owner.is_(None),
                            runtime_channel_switches.c.lease_until <= utc_now(),
                        ),
                    ),
                )
            )

    async def request_channel_retry(self, connector_id: str, runtime_id: str) -> None:
        async with channel_connection(self, write=True) as conn:
            await conn.execute(
                update(runtime_channel_sync)
                .where(
                    runtime_channel_sync.c.connector_id == connector_id,
                    runtime_channel_sync.c.runtime_id == runtime_id,
                )
                .values(next_retry_at=utc_now(), retry_count=0)
            )
