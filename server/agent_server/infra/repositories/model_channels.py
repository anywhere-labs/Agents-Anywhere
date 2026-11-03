from __future__ import annotations

from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from agent_server.core.utc import utc_now
from agent_server.infra.db.schema import (
    connectors,
    device_runtimes,
    model_channel_selections,
    runtime_admissions,
    runtime_channel_overrides,
    runtime_channel_switches,
)

# A switch holds a runtime closed to new tasks while it writes, verifies or
# rolls back; requests wait for it instead of reaching a restarting runtime.
GATED = (
    (runtime_channel_switches.c.state == "switching")
    & runtime_channel_switches.c.step.in_(("activating", "verifying"))
) | (runtime_channel_switches.c.state == "restoring")

_SWITCH_FIELDS = {
    "userId": "user_id",
    "state": "state",
    "step": "step",
    "targetChannel": "target_channel",
    "reason": "reason",
    "message": "message",
    "snapshotCiphertext": "snapshot_ciphertext",
    "switchRevision": "switch_revision",
    "operationId": "operation_id",
    "leaseUntil": "lease_until",
    "startedAt": "started_at",
}


def _admission_lock(connector_id: str) -> Any:
    # Per device: a managed instance and the runtime it serves share one gate.
    return select(func.pg_advisory_xact_lock(func.hashtextextended(f"runtime-admission:{connector_id}", 0)))


class ModelChannelRepositoryMixin:
    async def list_channel_runtime_users(self) -> list[str]:
        """Owners whose runtimes may need a switch even without a switch row."""
        async with self._engine.connect() as conn:
            return list((await conn.execute(
                select(connectors.c.user_id).join(
                    device_runtimes, device_runtimes.c.connector_id == connectors.c.id,
                ).distinct()
            )).scalars())

    async def create_channel_switch_if_missing(self, connector_id: str, runtime_id: str, *, user_id: str) -> bool:
        """Recover a missing job without overwriting another worker's progress."""
        now = utc_now()
        async with self._engine.begin() as conn:
            row = (await conn.execute(
                pg_insert(runtime_channel_switches).values(
                    connector_id=connector_id, runtime_id=runtime_id, user_id=user_id,
                    state="pending", started_at=now, updated_at=now,
                ).on_conflict_do_nothing(index_elements=["connector_id", "runtime_id"])
                .returning(runtime_channel_switches.c.runtime_id)
            )).first()
        return row is not None

    # The user's current channel.

    async def get_channel_selection(self, user_id: str) -> dict[str, Any] | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(
                select(model_channel_selections).where(model_channel_selections.c.user_id == user_id)
            )).mappings().first()
        return _selection_row(row) if row is not None else None

    async def save_channel_selection(self, user_id: str, channel: str | None = None) -> dict[str, Any]:
        """Set the channel (or keep it when None) and advance the revision."""
        now = utc_now()
        async with self._engine.begin() as conn:
            statement = pg_insert(model_channel_selections).values(
                user_id=user_id, channel=channel or "native", revision=1, updated_at=now,
            )
            values: dict[str, Any] = {
                "revision": model_channel_selections.c.revision + 1,
                "updated_at": now,
            }
            if channel is not None:
                values["channel"] = channel
            row = (await conn.execute(
                statement.on_conflict_do_update(index_elements=["user_id"], set_=values)
                .returning(*model_channel_selections.c)
            )).mappings().one()
        return _selection_row(row)

    async def list_channel_overrides(self, *, user_id: str) -> list[dict[str, Any]]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(
                select(runtime_channel_overrides)
                .join(connectors, connectors.c.id == runtime_channel_overrides.c.connector_id)
                .where(connectors.c.user_id == user_id)
            )).mappings().all()
        return [_override_row(row) for row in rows]

    async def set_channel_override(
        self, connector_id: str, runtime_id: str, channel: str | None, *, confirm_native_global: bool = False,
    ) -> None:
        async with self._engine.begin() as conn:
            if channel is None:
                await conn.execute(delete(runtime_channel_overrides).where(
                    runtime_channel_overrides.c.connector_id == connector_id,
                    runtime_channel_overrides.c.runtime_id == runtime_id,
                ))
                return
            values = {
                "connector_id": connector_id, "runtime_id": runtime_id, "channel": channel,
                "confirm_native_global": int(confirm_native_global), "updated_at": utc_now(),
            }
            statement = pg_insert(runtime_channel_overrides).values(**values)
            await conn.execute(statement.on_conflict_do_update(
                index_elements=["connector_id", "runtime_id"],
                set_={key: statement.excluded[key] for key in ("channel", "confirm_native_global", "updated_at")},
            ))

    # Switches: one row per runtime.

    async def get_channel_switch(self, connector_id: str, runtime_id: str) -> dict[str, Any] | None:
        async with self._engine.connect() as conn:
            row = (await conn.execute(select(runtime_channel_switches).where(
                runtime_channel_switches.c.connector_id == connector_id,
                runtime_channel_switches.c.runtime_id == runtime_id,
            ))).mappings().first()
        return _switch_row(row) if row is not None else None

    async def list_channel_switches(self, *, user_id: str) -> list[dict[str, Any]]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(
                select(runtime_channel_switches).where(runtime_channel_switches.c.user_id == user_id)
            )).mappings().all()
        return [_switch_row(row) for row in rows]

    async def list_unfinished_channel_switches(self, *, states: tuple[str, ...]) -> list[dict[str, Any]]:
        async with self._engine.connect() as conn:
            rows = (await conn.execute(
                select(runtime_channel_switches).where(runtime_channel_switches.c.state.in_(states))
            )).mappings().all()
        return [_switch_row(row) for row in rows]

    async def save_channel_switch(self, connector_id: str, runtime_id: str, values: dict[str, Any]) -> dict[str, Any]:
        """Create or update a runtime's switch row with the given fields."""
        columns = {_SWITCH_FIELDS[key]: value for key, value in values.items()}
        columns["updated_at"] = utc_now()
        async with self._engine.begin() as conn:
            if "user_id" not in columns:
                # A step of an existing switch: only its row changes.
                row = (await conn.execute(
                    update(runtime_channel_switches).where(
                        runtime_channel_switches.c.connector_id == connector_id,
                        runtime_channel_switches.c.runtime_id == runtime_id,
                    ).values(**columns).returning(*runtime_channel_switches.c)
                )).mappings().one()
                return _switch_row(row)
            statement = pg_insert(runtime_channel_switches).values(
                connector_id=connector_id, runtime_id=runtime_id,
                **{"state": "pending", **columns},
            )
            row = (await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=["connector_id", "runtime_id"],
                    set_={key: statement.excluded[key] for key in columns},
                ).returning(*runtime_channel_switches.c)
            )).mappings().one()
        return _switch_row(row)

    async def next_switch_revision(self, connector_id: str, runtime_id: str) -> int:
        """A runtime's switch revision only ever grows, so stale requests can be refused."""
        async with self._engine.begin() as conn:
            value = (await conn.execute(
                update(runtime_channel_switches)
                .where(
                    runtime_channel_switches.c.connector_id == connector_id,
                    runtime_channel_switches.c.runtime_id == runtime_id,
                )
                .values(switch_revision=runtime_channel_switches.c.switch_revision + 1, updated_at=utc_now())
                .returning(runtime_channel_switches.c.switch_revision)
            )).scalar_one()
        return int(value)

    # Admission: closing a runtime to new tasks without racing them.

    async def admit_runtime_request(
        self, connector_id: str, runtime_id: str, *, gate_runtime_ids: list[str],
        token: str, expires_at: str, now: str,
    ) -> bool:
        """Record a request about to start a task, unless a switch closed the runtime."""
        async with self._engine.begin() as conn:
            await conn.execute(_admission_lock(connector_id))
            gated = (await conn.execute(select(runtime_channel_switches.c.state).where(
                runtime_channel_switches.c.connector_id == connector_id,
                runtime_channel_switches.c.runtime_id.in_(gate_runtime_ids),
                runtime_channel_switches.c.lease_until > now,
                GATED,
            ))).first()
            if gated is not None:
                return False
            await conn.execute(runtime_admissions.insert().values(
                token=token, connector_id=connector_id, runtime_id=runtime_id, expires_at=expires_at,
            ))
        return True

    async def release_runtime_request(self, token: str) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(delete(runtime_admissions).where(runtime_admissions.c.token == token))

    async def close_runtime_for_switch(
        self, connector_id: str, runtime_id: str, values: dict[str, Any], *,
        now: str,
    ) -> None:
        """Close the runtime to new tasks before immediate replacement."""
        columns = {_SWITCH_FIELDS[key]: value for key, value in values.items()}
        async with self._engine.begin() as conn:
            await conn.execute(_admission_lock(connector_id))
            await conn.execute(delete(runtime_admissions).where(runtime_admissions.c.expires_at <= now))
            await conn.execute(update(runtime_channel_switches).where(
                runtime_channel_switches.c.connector_id == connector_id,
                runtime_channel_switches.c.runtime_id == runtime_id,
            ).values(**columns, updated_at=utc_now()))
    async def runtime_closed_for_switch(self, connector_id: str, runtime_ids: list[str], *, now: str) -> bool:
        async with self._engine.connect() as conn:
            return (await conn.execute(select(runtime_channel_switches.c.state).where(
                runtime_channel_switches.c.connector_id == connector_id,
                runtime_channel_switches.c.runtime_id.in_(runtime_ids),
                runtime_channel_switches.c.lease_until > now,
                GATED,
            ))).first() is not None


def _selection_row(row: Any) -> dict[str, Any]:
    return {"channel": row["channel"], "revision": row["revision"], "updatedAt": row["updated_at"]}


def _override_row(row: Any) -> dict[str, Any]:
    return {
        "connectorId": row["connector_id"],
        "runtimeId": row["runtime_id"],
        "channel": row["channel"],
        "confirmNativeGlobal": bool(row["confirm_native_global"]),
    }


def _switch_row(row: Any) -> dict[str, Any]:
    return {
        "connectorId": row["connector_id"],
        "runtimeId": row["runtime_id"],
        **{key: row[column] for key, column in _SWITCH_FIELDS.items()},
        "updatedAt": row["updated_at"],
    }
