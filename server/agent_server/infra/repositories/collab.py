"""Persistence for agent collaboration: account settings, delegation tokens, supervision edges, session origin.

Ids, states and hashes only; no content. ``core.agent_collab`` documents the model.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Sequence
from typing import Any

from sqlalchemy import Text, and_, func, or_, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncConnection

from agent_server.core.agent_collab import LIVE_EDGE_STATES, creates_cycle
from agent_server.core.utc import utc_now
from agent_server.infra.db.engine import read_connection
from agent_server.infra.db.schema import (
    agent_delegations,
    collab_edges,
    connectors,
    sessions,
    users,
)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _loads(value: Any) -> Any:
    if value is None or value == "":
        return None
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        return None


def edge_view(row: Any) -> dict[str, Any]:
    """A ``collab_edges`` row as ``protocol_v1_2.SupervisionEdge`` plus the device ids."""

    return {
        "supervisionId": row["supervision_id"],
        "supervisorSessionId": row["supervisor_session_id"],
        "supervisorDeviceId": row["supervisor_device_id"],
        "targetSessionId": row["target_session_id"],
        "targetDeviceId": row["target_device_id"],
        "state": row["state"],
        "createdBy": row["created_by"],
        "updatedAt": row["updated_at"],
    }


def _delegation_view(row: Any) -> dict[str, Any]:
    return {
        "delegationId": row["id"],
        "userId": row["user_id"],
        "deviceId": row["device_id"],
        "supervisorSessionId": row["supervisor_session_id"],
        "grantId": row["grant_id"],
        "scope": _loads(row["scope_json"]) or {},
        "expiresAt": row["expires_at"],
        "revokedAt": row["revoked_at"],
        "createdAt": row["created_at"],
    }


async def end_collab_for_sessions(conn: AsyncConnection, session_ids: Sequence[str]) -> None:
    """Sessions are going away: their edges end and the delegations they hold as supervisors are revoked."""

    ids = [session_id for session_id in session_ids if session_id]
    if not ids:
        return
    now = utc_now()
    await conn.execute(
        update(collab_edges)
        .where(
            or_(collab_edges.c.supervisor_session_id.in_(ids), collab_edges.c.target_session_id.in_(ids)),
            collab_edges.c.state != "ended",
        )
        .values(state="ended", updated_at=now)
    )
    await conn.execute(
        update(agent_delegations)
        .where(agent_delegations.c.supervisor_session_id.in_(ids), agent_delegations.c.revoked_at.is_(None))
        .values(revoked_at=now)
    )


async def end_collab_for_device(conn: AsyncConnection, device_id: str) -> None:
    """A device is going away: every edge it supervises or is the target of ends, its delegations are revoked."""

    now = utc_now()
    await conn.execute(
        update(collab_edges)
        .where(
            or_(collab_edges.c.supervisor_device_id == device_id, collab_edges.c.target_device_id == device_id),
            collab_edges.c.state != "ended",
        )
        .values(state="ended", updated_at=now)
    )
    await conn.execute(
        update(agent_delegations)
        .where(agent_delegations.c.device_id == device_id, agent_delegations.c.revoked_at.is_(None))
        .values(revoked_at=now)
    )


class CollabRepositoryMixin:
    # -- account settings -------------------------------------------------------------

    async def get_agent_collaboration(self, user_id: str) -> dict[str, Any] | None:
        """The stored settings JSON; raises ``KeyError`` for an unknown user."""

        async with read_connection(self._engine) as conn:
            row = (
                await conn.execute(select(users.c.agent_collaboration).where(users.c.id == user_id))
            ).first()
        if row is None:
            raise KeyError(user_id)
        value = _loads(row.agent_collaboration)
        return value if isinstance(value, dict) else None

    async def set_agent_collaboration(self, user_id: str, settings: dict[str, Any]) -> None:
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(users)
                .where(users.c.id == user_id)
                .values(agent_collaboration=_json(settings), updated_at=utc_now())
            )
        if result.rowcount == 0:
            raise KeyError(user_id)

    async def connector_agent_collaboration(self, connector_id: str) -> dict[str, Any] | None:
        """The settings of the account that owns ``connector_id`` (None when unset or unknown)."""

        async with read_connection(self._engine) as conn:
            row = (
                await conn.execute(
                    select(users.c.agent_collaboration)
                    .select_from(connectors.join(users, users.c.id == connectors.c.user_id))
                    .where(connectors.c.id == connector_id)
                )
            ).first()
        value = _loads(row.agent_collaboration) if row is not None else None
        return value if isinstance(value, dict) else None

    async def list_link_device_ids(self, user_id: str) -> list[str]:
        """The user's active devices that speak the v3 device link."""

        async with read_connection(self._engine) as conn:
            rows = (
                await conn.execute(
                    select(connectors.c.id).where(
                        connectors.c.user_id == user_id,
                        connectors.c.revoked == 0,
                        connectors.c.link_contract.is_not(None),
                    )
                )
            ).scalars()
            return list(rows)

    # -- delegations ---------------------------------------------------------------------

    async def create_agent_delegation(
        self,
        *,
        delegation_id: str,
        user_id: str,
        device_id: str,
        supervisor_session_id: str,
        grant_id: str,
        scope: dict[str, Any],
        token_hash: str,
        expires_at: str,
    ) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                agent_delegations.insert().values(
                    id=delegation_id,
                    user_id=user_id,
                    device_id=device_id,
                    supervisor_session_id=supervisor_session_id,
                    grant_id=grant_id,
                    scope_json=_json(scope),
                    token_hash=token_hash,
                    expires_at=expires_at,
                    revoked_at=None,
                    created_at=utc_now(),
                )
            )

    async def agent_delegation_by_token(self, token_hash: str) -> dict[str, Any] | None:
        """The delegation with this token hash, with what checking it needs: the owner's account state and
        collaboration settings, whether the device is still active, and the supervisor session's runtime and
        device (None when the session is gone)."""

        query = (
            select(
                agent_delegations,
                users.c.disabled.label("user_disabled"),
                users.c.agent_collaboration.label("user_collaboration"),
                connectors.c.revoked.label("device_revoked"),
                connectors.c.user_id.label("device_user_id"),
                sessions.c.runtime_id.label("supervisor_runtime_id"),
                sessions.c.connector_id.label("supervisor_device_id"),
            )
            .select_from(
                agent_delegations.join(users, users.c.id == agent_delegations.c.user_id)
                .join(connectors, connectors.c.id == agent_delegations.c.device_id)
                .outerjoin(sessions, sessions.c.id == agent_delegations.c.supervisor_session_id)
            )
            .where(agent_delegations.c.token_hash == token_hash)
        )
        async with read_connection(self._engine) as conn:
            row = (await conn.execute(query)).mappings().first()
        if row is None:
            return None
        view = _delegation_view(row)
        collaboration = _loads(row["user_collaboration"])
        view.update(
            userDisabled=bool(row["user_disabled"]),
            collaboration=collaboration if isinstance(collaboration, dict) else None,
            deviceActive=int(row["device_revoked"] or 0) == 0 and row["device_user_id"] == row["user_id"],
            supervisorRuntimeId=row["supervisor_runtime_id"],
            supervisorDeviceId=row["supervisor_device_id"],
        )
        return view

    async def revoke_agent_delegations(
        self,
        *,
        device_id: str,
        grant_id: str | None = None,
        supervisor_session_id: str | None = None,
    ) -> int:
        """Revoke the device's delegations of ``grant_id`` (or of a supervisor session, or all of them)."""

        conditions = [agent_delegations.c.device_id == device_id, agent_delegations.c.revoked_at.is_(None)]
        if grant_id is not None:
            conditions.append(agent_delegations.c.grant_id == grant_id)
        if supervisor_session_id is not None:
            conditions.append(agent_delegations.c.supervisor_session_id == supervisor_session_id)
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(agent_delegations).where(and_(*conditions)).values(revoked_at=utc_now())
            )
        return int(result.rowcount or 0)

    # -- supervision edges ------------------------------------------------------------------

    async def upsert_collab_edge(
        self,
        *,
        supervision_id: str,
        user_id: str,
        supervisor_session_id: str,
        supervisor_device_id: str,
        target_session_id: str,
        target_device_id: str,
        state: str,
        created_by: str,
        at: str,
    ) -> tuple[dict[str, Any] | None, bool]:
        """Store the edge as the supervisor's device reported it; returns ``(edge, refused)``.

        An edge that would close a cycle among the user's live edges is stored as ``ended`` (``refused``). A report
        older than the stored one (by ``at``) or about another user's edge changes nothing. The user's edges are
        serialized by a transaction advisory lock so two concurrent edges cannot form a cycle together.
        """

        async with self._engine.begin() as conn:
            await conn.execute(
                text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
                {"key": f"collab-edges:{user_id}"},
            )
            existing = (
                await conn.execute(
                    select(collab_edges).where(collab_edges.c.supervision_id == supervision_id).with_for_update()
                )
            ).mappings().first()
            if existing is not None and (existing["user_id"] != user_id or existing["updated_at"] > at):
                return (edge_view(existing) if existing["user_id"] == user_id else None), False
            if existing is not None and existing["state"] == "ended" and state in LIVE_EDGE_STATES:
                # An ended edge never comes back; the device opens a new supervision instead.
                return edge_view(existing), False
            refused = False
            if state in LIVE_EDGE_STATES and existing is None:
                live = (
                    await conn.execute(
                        select(collab_edges.c.supervisor_session_id, collab_edges.c.target_session_id).where(
                            collab_edges.c.user_id == user_id,
                            collab_edges.c.state.in_(LIVE_EDGE_STATES),
                            collab_edges.c.supervision_id != supervision_id,
                        )
                    )
                ).all()
                if creates_cycle(
                    ((row.supervisor_session_id, row.target_session_id) for row in live),
                    supervisor_session_id,
                    target_session_id,
                ):
                    state, refused = "ended", True
            values = {
                "supervision_id": supervision_id,
                "user_id": user_id,
                "supervisor_session_id": supervisor_session_id,
                "supervisor_device_id": supervisor_device_id,
                "target_session_id": target_session_id,
                "target_device_id": target_device_id,
                "state": state,
                "created_by": created_by,
                "updated_at": at,
            }
            statement = pg_insert(collab_edges).values(**values)
            statement = statement.on_conflict_do_update(
                index_elements=["supervision_id"],
                set_={key: statement.excluded[key] for key in values if key not in ("supervision_id", "user_id")},
            )
            row = (await conn.execute(statement.returning(*collab_edges.c))).mappings().one()
        return edge_view(row), refused

    async def live_collab_edges_for_targets(self, session_ids: Iterable[str]) -> list[dict[str, Any]]:
        """Active and paused edges whose target is one of ``session_ids``."""

        ids = list(dict.fromkeys(session_ids))
        if not ids:
            return []
        async with read_connection(self._engine) as conn:
            rows = (
                await conn.execute(
                    select(collab_edges)
                    .where(collab_edges.c.target_session_id.in_(ids), collab_edges.c.state.in_(LIVE_EDGE_STATES))
                    .order_by(collab_edges.c.supervision_id)
                )
            ).mappings().all()
        return [edge_view(row) for row in rows]

    async def live_collab_edges_for_target_device(self, device_id: str) -> list[dict[str, Any]]:
        """Active and paused edges whose target session is on ``device_id``."""

        async with read_connection(self._engine) as conn:
            rows = (
                await conn.execute(
                    select(collab_edges)
                    .where(collab_edges.c.target_device_id == device_id, collab_edges.c.state.in_(LIVE_EDGE_STATES))
                    .order_by(collab_edges.c.supervision_id)
                )
            ).mappings().all()
        return [edge_view(row) for row in rows]

    async def get_collab_edge(self, supervision_id: str) -> dict[str, Any] | None:
        async with read_connection(self._engine) as conn:
            row = (
                await conn.execute(select(collab_edges).where(collab_edges.c.supervision_id == supervision_id))
            ).mappings().first()
        return edge_view(row) if row is not None else None

    # -- session origin and signal state ------------------------------------------------------

    async def set_session_origin(self, session_id: str, origin: dict[str, Any]) -> bool:
        """Record who created the session unless an origin is already stored (it never changes)."""

        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(sessions)
                .where(sessions.c.id == session_id, sessions.c.origin_kind.is_(None))
                .values(
                    origin_kind=str(origin["kind"]),
                    origin_session_id=str(origin["bySessionId"]),
                    origin_device_id=origin.get("byDeviceId"),
                    origin_depth=int(origin["depth"]),
                )
            )
        return bool(result.rowcount)

    async def session_origin_depth(self, session_id: str) -> int:
        """How deep in a chain of Agent-created sessions ``session_id`` is (0 for a person's session)."""

        async with read_connection(self._engine) as conn:
            value = (
                await conn.execute(select(sessions.c.origin_depth).where(sessions.c.id == session_id))
            ).scalar_one_or_none()
        return int(value or 0)

    async def session_signal_states(self, session_ids: Iterable[str]) -> dict[str, dict[str, Any]]:
        """The directory fields a supervisor is signalled about, per session."""

        ids = list(dict.fromkeys(session_ids))
        if not ids:
            return {}
        async with read_connection(self._engine) as conn:
            rows = (
                await conn.execute(
                    select(
                        sessions.c.id,
                        sessions.c.connector_id,
                        sessions.c.status,
                        sessions.c.head_seq,
                        sessions.c.reset_seq,
                        sessions.c.latest_turn_end_seq,
                        sessions.c.plan_state,
                        sessions.c.goal_state,
                    ).where(sessions.c.id.in_(ids))
                )
            ).all()
        return {
            row.id: {
                "deviceId": row.connector_id,
                "status": row.status,
                "headSeq": int(row.head_seq or 0),
                "resetSeq": int(row.reset_seq or 0),
                "latestTurnEndSeq": int(row.latest_turn_end_seq or 0),
                "planState": row.plan_state or "none",
                "goalState": row.goal_state or "none",
            }
            for row in rows
        }


def edges_json_column(side: Any, session_id: Any) -> Any:
    """A correlated subquery: the non-ended edges where ``side`` (a ``collab_edges`` column) is ``session_id``,
    as a JSON array of ``SupervisionEdge`` objects (text)."""

    return (
        select(
            func.coalesce(
                func.json_agg(
                    func.json_build_object(
                        "supervisionId", collab_edges.c.supervision_id,
                        "supervisorSessionId", collab_edges.c.supervisor_session_id,
                        "targetSessionId", collab_edges.c.target_session_id,
                        "state", collab_edges.c.state,
                        "createdBy", collab_edges.c.created_by,
                    )
                ),
                text("'[]'::json"),
            ).cast(Text())
        )
        .where(side == session_id, collab_edges.c.state != "ended")
        .scalar_subquery()
    )
