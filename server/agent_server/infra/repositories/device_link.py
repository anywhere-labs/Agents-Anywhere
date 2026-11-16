"""Persistence for the v3 device link (device-meshcall 1.0).

- Directory fields a v3 device reports for its sessions (never content).
- ``seq_ceiling`` and the per-session floors handed to the device on hello.
- ``device_commands``: durable command receipts.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import and_, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from agent_server.core.device_meshcall import DisplayEnvelope, SessionSummary
from agent_server.core.utc import utc_now
from agent_server.infra.db.engine import read_connection
from agent_server.infra.db.schema import connectors, device_commands, sessions

COMMAND_RECEIPT_TTL = timedelta(days=7)


def _json(value: Any) -> str | None:
    if value is None:
        return None
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _receipt_view(row: Any) -> dict[str, Any]:
    return {
        "userId": row["user_id"],
        "commandId": row["command_id"],
        "kind": row["kind"],
        "inputDigest": row["input_digest"],
        "deviceId": row["device_id"],
        "sessionId": row["session_id"],
        "state": row["state"],
        "payload": json.loads(row["payload_json"]) if row["payload_json"] else None,
        "result": json.loads(row["result_json"]) if row["result_json"] else None,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "expiresAt": row["expires_at"],
    }


class DeviceLinkRepositoryMixin:
    # -- devices ----------------------------------------------------------------

    async def set_connector_link_contract(self, connector_id: str, contract: str | None) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                update(connectors)
                .where(connectors.c.id == connector_id)
                .values(link_contract=contract, updated_at=utc_now())
            )

    async def connector_link_contract(self, connector_id: str) -> str | None:
        async with read_connection(self._engine) as conn:
            return (
                await conn.execute(select(connectors.c.link_contract).where(connectors.c.id == connector_id))
            ).scalar_one_or_none()

    async def connector_link_contracts(self, connector_ids: list[str]) -> dict[str, str | None]:
        if not connector_ids:
            return {}
        async with read_connection(self._engine) as conn:
            rows = (
                await conn.execute(
                    select(connectors.c.id, connectors.c.link_contract).where(connectors.c.id.in_(connector_ids))
                )
            ).all()
        return {row.id: row.link_contract for row in rows}

    # -- session clocks -----------------------------------------------------------

    async def device_seq_floors(self, connector_id: str, reported: dict[str, int]) -> dict[str, int]:
        """``sessionId -> max(head_seq, seq_ceiling)`` where it is above what the device reported."""

        floor = func.greatest(sessions.c.head_seq, sessions.c.seq_ceiling)
        async with read_connection(self._engine) as conn:
            rows = (
                await conn.execute(
                    select(sessions.c.id, floor.label("floor")).where(
                        sessions.c.connector_id == connector_id, floor > 0
                    )
                )
            ).all()
        return {row.id: int(row.floor) for row in rows if int(row.floor) >= reported.get(row.id, 0)}

    async def session_seq_ceiling(self, session_id: str) -> int:
        async with read_connection(self._engine) as conn:
            value = (
                await conn.execute(select(sessions.c.seq_ceiling).where(sessions.c.id == session_id))
            ).scalar_one_or_none()
        return int(value or 0)

    async def raise_session_seq_ceiling(self, session_id: str, ceiling: int) -> int:
        """Raise ``seq_ceiling`` to at least ``ceiling`` and return the stored value."""

        async with self._engine.begin() as conn:
            value = (
                await conn.execute(
                    update(sessions)
                    .where(sessions.c.id == session_id)
                    .values(seq_ceiling=func.greatest(sessions.c.seq_ceiling, ceiling))
                    .returning(sessions.c.seq_ceiling)
                )
            ).scalar_one_or_none()
        return int(value or 0)

    # -- reported directory fields --------------------------------------------

    async def apply_device_session_summary(
        self, session_id: str, summary: SessionSummary, *, reported_at: str | None = None
    ) -> bool:
        """Store a device summary unless it is older than what is stored (by ``headSeq``).

        Returns whether anything a client would see changed.
        """

        latest = summary.latestItem
        display = summary.displayDevice
        values: dict[str, Any] = {
            "head_seq": summary.headSeq,
            "reset_seq": summary.resetSeq,
            "plan_state": summary.planState,
            "goal_state": summary.goalState,
            "status": summary.status if summary.status != "unknown" else "idle",
            "sort_at": summary.sortAt,
            "last_activity_at": summary.lastActivityAt,
            "latest_item_id": latest.id if latest else None,
            "latest_item_type": latest.type if latest else None,
            "latest_item_role": latest.role if latest else None,
            "latest_item_status": latest.status if latest else None,
            "latest_item_time": latest.time if latest else None,
            "display_device": _json(display.model_dump(mode="json", exclude_none=True)),
            "reported_at": reported_at or utc_now(),
            "updated_at": utc_now(),
        }
        if summary.latestTurnEndSeq is not None:
            values["latest_turn_end_seq"] = summary.latestTurnEndSeq
        # Plain envelopes keep the v2 title/cwd columns current for clients that do not read
        # envelopes yet; sealed ones clear them (the Server must not hold plaintext).
        if display.mode == "plain" and isinstance(display.payload, dict):
            if isinstance(display.payload.get("title"), str):
                values["title"] = display.payload["title"]
            if isinstance(display.payload.get("cwd"), str):
                values["cwd"] = display.payload["cwd"]
        elif display.mode == "sealed":
            values["title"] = None
            values["cwd"] = None
        async with self._engine.begin() as conn:
            before = (
                await conn.execute(
                    select(
                        sessions.c.head_seq,
                        sessions.c.status,
                        sessions.c.plan_state,
                        sessions.c.goal_state,
                        sessions.c.latest_turn_end_seq,
                        sessions.c.display_device,
                        sessions.c.sort_at,
                    )
                    .where(sessions.c.id == session_id)
                    .with_for_update()
                )
            ).first()
            if before is None or int(before.head_seq) > summary.headSeq:
                return False
            await conn.execute(update(sessions).where(sessions.c.id == session_id).values(**values))
        return (
            before.status != values["status"]
            or before.plan_state != summary.planState
            or before.goal_state != summary.goalState
            or (summary.latestTurnEndSeq is not None and int(before.latest_turn_end_seq) != summary.latestTurnEndSeq)
            or before.display_device != values["display_device"]
            or before.sort_at != summary.sortAt
            or int(before.head_seq) != summary.headSeq
        )

    async def set_session_display_user(self, session_id: str, envelope: DisplayEnvelope | None) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                update(sessions)
                .where(sessions.c.id == session_id)
                .values(
                    display_user=_json(envelope.model_dump(mode="json", exclude_none=True)) if envelope else None,
                    updated_at=utc_now(),
                )
            )

    async def session_directory_fields(self, session_id: str) -> dict[str, Any] | None:
        async with read_connection(self._engine) as conn:
            row = (
                await conn.execute(
                    select(
                        sessions.c.head_seq,
                        sessions.c.reset_seq,
                        sessions.c.seq_ceiling,
                        sessions.c.plan_state,
                        sessions.c.goal_state,
                        sessions.c.display_device,
                        sessions.c.display_user,
                        sessions.c.reported_at,
                    ).where(sessions.c.id == session_id)
                )
            ).mappings().first()
        if row is None:
            return None
        return {
            "headSeq": int(row["head_seq"]),
            "resetSeq": int(row["reset_seq"]),
            "seqCeiling": int(row["seq_ceiling"]),
            "planState": row["plan_state"],
            "goalState": row["goal_state"],
            "displayDevice": json.loads(row["display_device"]) if row["display_device"] else None,
            "displayUser": json.loads(row["display_user"]) if row["display_user"] else None,
            "reportedAt": row["reported_at"],
        }

    # -- command receipts ---------------------------------------------------------

    async def record_device_command(
        self,
        *,
        user_id: str,
        command_id: str,
        kind: str,
        device_id: str,
        session_id: str | None,
        input_digest: str | None,
        payload: dict[str, Any] | None,
    ) -> tuple[dict[str, Any], bool]:
        """Insert a ``pending`` receipt; returns ``(receipt, created)``. An existing one is returned as is."""

        now = datetime.now(UTC)
        row = {
            "user_id": user_id,
            "command_id": command_id,
            "kind": kind,
            "input_digest": input_digest,
            "device_id": device_id,
            "session_id": session_id,
            "state": "pending",
            "payload_json": _json(payload),
            "result_json": None,
            "created_at": now.isoformat(),
            "updated_at": now.isoformat(),
            "expires_at": (now + COMMAND_RECEIPT_TTL).isoformat(),
        }
        async with self._engine.begin() as conn:
            inserted = (
                await conn.execute(
                    pg_insert(device_commands)
                    .values(**row)
                    .on_conflict_do_nothing(index_elements=["user_id", "command_id"])
                    .returning(device_commands.c.command_id)
                )
            ).first()
            existing = (
                await conn.execute(
                    select(device_commands).where(
                        device_commands.c.user_id == user_id, device_commands.c.command_id == command_id
                    )
                )
            ).mappings().one()
        return _receipt_view(existing), inserted is not None

    async def settle_device_command(
        self,
        *,
        device_id: str,
        command_id: str,
        state: str,
        result: dict[str, Any] | None,
        user_id: str | None = None,
        only_from: tuple[str, ...] = ("pending", "unknown"),
    ) -> dict[str, Any] | None:
        """Move a receipt to ``state`` if it is still in ``only_from``; terminal states never move back."""

        conditions = [
            device_commands.c.device_id == device_id,
            device_commands.c.command_id == command_id,
            device_commands.c.state.in_(only_from),
        ]
        if user_id is not None:
            conditions.append(device_commands.c.user_id == user_id)
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    update(device_commands)
                    .where(and_(*conditions))
                    .values(state=state, result_json=_json(result), updated_at=utc_now())
                    .returning(*device_commands.c)
                )
            ).mappings().first()
        return _receipt_view(row) if row is not None else None

    async def get_device_command(self, user_id: str, command_id: str) -> dict[str, Any] | None:
        async with read_connection(self._engine) as conn:
            row = (
                await conn.execute(
                    select(device_commands).where(
                        device_commands.c.user_id == user_id, device_commands.c.command_id == command_id
                    )
                )
            ).mappings().first()
        return _receipt_view(row) if row is not None else None

    async def unsettled_device_commands(self, device_id: str, *, limit: int = 200) -> list[dict[str, Any]]:
        """Commands whose outcome is still unknown (or that never got an answer), oldest first."""

        now = datetime.now(UTC).isoformat()
        async with read_connection(self._engine) as conn:
            rows = (
                await conn.execute(
                    select(device_commands)
                    .where(
                        device_commands.c.device_id == device_id,
                        device_commands.c.state.in_(("pending", "unknown")),
                        device_commands.c.expires_at > now,
                    )
                    .order_by(device_commands.c.created_at)
                    .limit(limit)
                )
            ).mappings().all()
        return [_receipt_view(row) for row in rows]
