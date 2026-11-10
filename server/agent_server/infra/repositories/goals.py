from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import and_, delete, insert, or_, select, update

from agent_server.core.utc import utc_now
from agent_server.infra.db.schema import (
    goal_event_outbox,
    goal_operations,
    session_goal_state,
    session_goals,
    sessions,
    timeline_items,
)
from agent_server.infra.db.engine import read_connection
from agent_server.infra.repositories.store_support import session_revision_fenced

TERMINAL = {"complete", "failed", "cleared", "replaced"}


def encode(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


class GoalRepositoryMixin:
    async def read_goal(self, session_id):
        async with read_connection(self._engine) as c:
            raw = (
                await c.execute(
                    select(session_goal_state.c.payload).where(
                        session_goal_state.c.session_id == session_id
                    )
                )
            ).scalar_one_or_none()
        if not raw:
            return None
        value = {k: v for k, v in json.loads(raw).items() if not k.startswith("_")}
        value["freshness"] = "stale"
        value["capabilities"] = {**value.get("capabilities", {}), "actions": []}
        return value

    async def goal_session_ids(self, session_ids):
        if not session_ids:
            return []
        async with read_connection(self._engine) as c:
            return list(
                (
                    await c.execute(
                        select(session_goal_state.c.session_id).where(
                            session_goal_state.c.session_id.in_(session_ids)
                        )
                    )
                ).scalars()
            )

    async def pending_goal_operation(self, session_id):
        async with read_connection(self._engine) as c:
            return (
                await c.execute(
                    select(goal_operations.c.operation_id)
                    .where(
                        goal_operations.c.session_id == session_id,
                        goal_operations.c.state.in_(
                            ["reserved", "dispatched", "unknown"]
                        ),
                    )
                    .order_by(goal_operations.c.created_at)
                    .limit(1)
                )
            ).scalar_one_or_none()

    async def replay_goal_operation(self, session_id, request):
        async with read_connection(self._engine) as c:
            row = (
                (
                    await c.execute(
                        select(goal_operations).where(
                            goal_operations.c.session_id == session_id,
                            goal_operations.c.operation_id == request["operationId"],
                        )
                    )
                )
                .mappings()
                .first()
            )
        if row is None:
            return None
        if row["fingerprint"] != hashlib.sha256(encode(request).encode()).hexdigest():
            raise ValueError("goal_operation_identity_conflict")
        return (
            json.loads(row["result_payload"])
            if row["result_payload"]
            else {
                "operationId": request["operationId"],
                "ok": False,
                "outcome": "unknown",
                "code": "goal_outcome_unknown",
            }
        )

    async def reserve_goal_operation(self, session_id, request, *, binding=None):
        fingerprint = hashlib.sha256(encode(request).encode()).hexdigest()
        async with self._engine.begin() as c:
            bound = (
                (
                    await c.execute(
                        select(sessions)
                        .where(sessions.c.id == session_id)
                        .with_for_update()
                    )
                )
                .mappings()
                .one()
            )
            if binding is not None and any(
                bound[column] != binding[key]
                for column, key in (
                    ("connector_id", "connectorId"),
                    ("runtime_id", "runtimeId"),
                    ("runtime", "runtime"),
                    ("external_session_id", "externalSessionId"),
                )
            ):
                raise ValueError("goal_binding_changed")
            if bound["archived"] or not bound["takeover"]:
                raise ValueError("goal_control_not_allowed")
            key = and_(
                goal_operations.c.session_id == session_id,
                goal_operations.c.operation_id == request["operationId"],
            )
            old = (
                (await c.execute(select(goal_operations).where(key))).mappings().first()
            )
            if old:
                if old["fingerprint"] != fingerprint:
                    raise ValueError("goal_operation_identity_conflict")
                return (
                    json.loads(old["result_payload"])
                    if old["result_payload"]
                    else {
                        "operationId": request["operationId"],
                        "ok": False,
                        "outcome": "unknown",
                        "code": "goal_outcome_unknown",
                    }
                )
            state = (
                (
                    await c.execute(
                        select(session_goal_state).where(
                            session_goal_state.c.session_id == session_id
                        )
                    )
                )
                .mappings()
                .first()
            )
            if request["expectedRevision"] != (state["revision"] if state else 0):
                raise ValueError("goal_revision_conflict")
            pending = (
                await c.execute(
                    select(goal_operations.c.operation_id)
                    .where(
                        goal_operations.c.session_id == session_id,
                        goal_operations.c.state.in_(
                            ["reserved", "dispatched", "unknown"]
                        ),
                    )
                    .limit(1)
                )
            ).scalar_one_or_none()
            if pending:
                raise ValueError("goal_operation_pending")
            now = utc_now()
            await c.execute(
                insert(goal_operations).values(
                    session_id=session_id,
                    operation_id=request["operationId"],
                    fingerprint=fingerprint,
                    action=request["action"],
                    expected_revision=request["expectedRevision"],
                    binding_generation=state["binding_generation"] if state else 0,
                    state="reserved",
                    request_payload=encode(request),
                    created_at=now,
                    updated_at=now,
                )
            )
        return None

    async def get_goal_operation(self, session_id, operation_id):
        async with read_connection(self._engine) as c:
            row = (
                (
                    await c.execute(
                        select(goal_operations).where(
                            goal_operations.c.session_id == session_id,
                            goal_operations.c.operation_id == operation_id,
                        )
                    )
                )
                .mappings()
                .first()
            )
        if not row:
            return None
        return (
            json.loads(row["result_payload"])
            if row["result_payload"]
            else {
                "operationId": operation_id,
                "ok": False,
                "outcome": "unknown",
                "code": "goal_outcome_unknown",
            }
        )

    async def mark_goal_dispatched(self, session_id, operation_id):
        async with self._engine.begin() as c:
            await c.execute(
                update(goal_operations)
                .where(
                    goal_operations.c.session_id == session_id,
                    goal_operations.c.operation_id == operation_id,
                    goal_operations.c.state == "reserved",
                )
                .values(state="dispatched", updated_at=utc_now())
            )

    @session_revision_fenced
    async def save_goal(
        self, session_id, state, *, connector_id, reconcile=False, operation=None
    ):
        async with self._engine.begin() as c:
            bound = (
                (
                    await c.execute(
                        select(sessions)
                        .where(sessions.c.id == session_id)
                        .with_for_update()
                    )
                )
                .mappings()
                .first()
            )
            if (
                not bound
                or bound["connector_id"] != connector_id
                or bound["runtime_id"] != state.get("runtimeId")
                or bound["runtime"] != state["runtime"]
                or bound["external_session_id"] != state.get("externalSessionId")
            ):
                raise ValueError("goal_binding_invalid")
            row = (
                (
                    await c.execute(
                        select(session_goal_state).where(
                            session_goal_state.c.session_id == session_id
                        )
                    )
                )
                .mappings()
                .first()
            )
            old = json.loads(row["payload"]) if row else None
            binding = [
                bound["connector_id"],
                bound["runtime_id"],
                bound["external_session_id"],
            ]
            changed_binding = old is not None and old.get("_binding") != binding
            generation = (row["binding_generation"] if row else 0) + int(
                changed_binding
            )
            epoch_changed = row and row["source_epoch"] != state["sourceEpoch"]
            if changed_binding or epoch_changed:
                if not reconcile:
                    raise ValueError("goal_reconciliation_required")
            elif row and state["sourceRevision"] < row["source_revision"]:
                saved = {k: v for k, v in old.items() if not k.startswith("_")}
                if operation:
                    await self._save_goal_receipt(
                        c, session_id, {**operation, "state": saved}
                    )
                return saved
            elif (
                row
                and state["sourceRevision"] == row["source_revision"]
                and any(
                    old.get(key) != state.get(key) for key in ("goal", "lastOutcome")
                )
            ):
                raise ValueError("goal_source_revision_conflict")
            now = utc_now()
            incoming = {**state, "bindingGeneration": generation}
            if incoming.get("lastOutcome") is None and old and old.get("lastOutcome"):
                incoming["lastOutcome"] = old["lastOutcome"]
            # Capabilities and freshness are live observations, not lifecycle revisions.
            semantic = lambda s: {
                k: s.get(k)
                for k in ("goal", "lastOutcome", "sourceEpoch", "sourceRevision")
            }
            changed = (
                old is None or changed_binding or semantic(old) != semantic(incoming)
            )
            revision = (row["revision"] if row else 0) + int(changed)
            incoming["revision"] = revision
            if changed:
                current = incoming.get("goal")
                current_id = current["id"] if current else None
                # End the prior target before inserting another live target.
                if (
                    row
                    and row["current_goal_id"]
                    and row["current_goal_id"] != current_id
                ):
                    previous = (old or {}).get("goal")
                    outcome = state.get("lastOutcome")
                    if previous:
                        ended = (
                            outcome
                            if outcome and outcome["id"] == previous["id"]
                            else {
                                **previous,
                                "status": "replaced"
                                if current
                                or (outcome and outcome["id"] != previous["id"])
                                else "cleared",
                                "endedAt": now,
                                "updatedAt": now,
                            }
                        )
                        if not outcome or outcome["id"] == previous["id"]:
                            incoming["lastOutcome"] = ended
                        await c.execute(
                            update(session_goals)
                            .where(
                                session_goals.c.session_id == session_id,
                                session_goals.c.goal_id == previous["id"],
                            )
                            .values(
                                status=ended["status"],
                                ended_at=ended.get("endedAt") or now,
                                updated_at=now,
                                source_revision=state["sourceRevision"],
                                payload=encode(ended),
                            )
                        )
                for goal in [incoming.get("lastOutcome"), current]:
                    if goal is None:
                        continue
                    values = {
                        "status": goal["status"],
                        "source_revision": state["sourceRevision"],
                        "payload": encode(goal),
                        "created_at": goal["createdAt"],
                        "updated_at": goal["updatedAt"],
                        "ended_at": (goal.get("endedAt") or now)
                        if goal["status"] in TERMINAL
                        else None,
                    }
                    exists = (
                        await c.execute(
                            select(session_goals.c.goal_id).where(
                                session_goals.c.session_id == session_id,
                                session_goals.c.goal_id == goal["id"],
                            )
                        )
                    ).scalar_one_or_none()
                    if exists:
                        await c.execute(
                            update(session_goals)
                            .where(
                                session_goals.c.session_id == session_id,
                                session_goals.c.goal_id == goal["id"],
                            )
                            .values(**values)
                        )
                    else:
                        await c.execute(
                            insert(session_goals).values(
                                session_id=session_id, goal_id=goal["id"], **values
                            )
                        )
                event_id = str(uuid4())
                sequence = await self._bump_session(c, session_id)
                envelope = {
                    "sessionId": session_id,
                    "nextSeq": sequence,
                    "goalState": incoming,
                    "goalEventId": event_id,
                }
                prior_goal = (old or {}).get("goal") or (old or {}).get("lastOutcome")
                next_goal = incoming.get("goal") or incoming.get("lastOutcome")
                if next_goal and (
                    not prior_goal
                    or prior_goal.get("id") != next_goal.get("id")
                    or prior_goal.get("status") != next_goal.get("status")
                    or prior_goal.get("objective") != next_goal.get("objective")
                ):
                    order = (
                        await c.execute(
                            select(timeline_items.c.order_seq)
                            .where(timeline_items.c.session_id == session_id)
                            .order_by(timeline_items.c.order_seq.desc())
                            .limit(1)
                        )
                    ).scalar_one_or_none() or 0
                    content = {"kind": "goal", "goal": next_goal}
                    item = {
                        "id": "goal_" + event_id,
                        "sessionId": session_id,
                        "type": "marker",
                        "status": "done",
                        "role": "system",
                        "content": content,
                        "source": {
                            "runtime": "platform",
                            "sessionId": session_id,
                            "itemType": "goal",
                        },
                        "orderSeq": order + 1,
                        "revision": 1,
                        "contentHash": "sha256:"
                        + hashlib.sha256(encode(content).encode()).hexdigest(),
                        "createdAt": now,
                        "updatedAt": now,
                        "updatedSeq": sequence,
                    }
                    await c.execute(
                        insert(timeline_items).values(
                            session_id=session_id,
                            id=item["id"],
                            type="marker",
                            status="done",
                            role="system",
                            order_seq=order + 1,
                            updated_seq=sequence,
                            item_time=now,
                            payload_json=encode(item),
                        )
                    )
                    await self.timeline.refresh_session_latest(c, session_id)
                    envelope["items"] = [item]
                await c.execute(
                    insert(goal_event_outbox).values(
                        event_id=event_id,
                        session_id=session_id,
                        state_revision=revision,
                        kind="goal.updated",
                        payload=encode(envelope),
                        created_at=now,
                        next_attempt_at=now,
                    )
                )
            values = {
                "current_goal_id": (incoming.get("goal") or {}).get("id"),
                "last_outcome_goal_id": (incoming.get("lastOutcome") or {}).get("id"),
                "revision": revision,
                "binding_generation": generation,
                "source_epoch": state["sourceEpoch"],
                "source_revision": state["sourceRevision"],
                "payload": encode({**incoming, "_binding": binding}),
                "observed_at": now,
                "updated_at": now,
            }
            if row:
                await c.execute(
                    update(session_goal_state)
                    .where(session_goal_state.c.session_id == session_id)
                    .values(**values)
                )
            else:
                await c.execute(
                    insert(session_goal_state).values(session_id=session_id, **values)
                )
            if operation:
                result = {**operation, "state": incoming}
                await self._save_goal_receipt(c, session_id, result)
            return incoming

    async def _save_goal_receipt(self, c, session_id, result):
        status = {"applied": "confirmed", "rejected": "rejected"}.get(
            result["outcome"], "unknown"
        )
        saved = await c.execute(
            update(goal_operations)
            .where(
                goal_operations.c.session_id == session_id,
                goal_operations.c.operation_id == result["operationId"],
                goal_operations.c.state.notin_(["confirmed", "rejected"]),
            )
            .values(
                state=status,
                result_payload=encode(result),
                updated_at=utc_now(),
                finished_at=utc_now() if status in {"confirmed", "rejected"} else None,
            )
            .returning(goal_operations.c.operation_id)
        )

        if saved.scalar_one_or_none() is None:
            return
        if result.get("outcome") in {"applied", "rejected"}:
            from agent_server.infra.db.schema import runtime_workflows

            row = (
                (
                    await c.execute(
                        select(runtime_workflows).where(
                            runtime_workflows.c.kind == "goal_creation",
                            runtime_workflows.c.id == result["operationId"],
                            runtime_workflows.c.session_id == session_id,
                        )
                    )
                )
                .mappings()
                .first()
            )
            if row:
                saved = json.loads(row["result_json"])
                bound = (
                    await c.execute(
                        select(sessions.c.external_session_id).where(
                            sessions.c.id == session_id
                        )
                    )
                ).scalar_one_or_none()
                saved["connectorResult"] = {
                    **saved.get("connectorResult", {}),
                    "ok": result["ok"],
                    "goal": result,
                    "messageAccepted": result["ok"],
                    "externalSessionId": bound,
                }
                await c.execute(
                    update(runtime_workflows)
                    .where(
                        runtime_workflows.c.user_id == row["user_id"],
                        runtime_workflows.c.kind == "goal_creation",
                        runtime_workflows.c.id == row["id"],
                    )
                    .values(result_json=encode(saved))
                )

    async def save_goal_operation(self, session_id, result):
        async with self._engine.begin() as c:
            await self._save_goal_receipt(c, session_id, result)

    async def claim_goal_events(self, owner):
        now = utc_now()
        until = (datetime.now(UTC) + timedelta(seconds=30)).isoformat()
        async with self._engine.begin() as c:
            rows = (
                (
                    await c.execute(
                        select(goal_event_outbox)
                        .where(
                            goal_event_outbox.c.delivered_at.is_(None),
                            goal_event_outbox.c.next_attempt_at <= now,
                            or_(
                                goal_event_outbox.c.claim_until.is_(None),
                                goal_event_outbox.c.claim_until < now,
                            ),
                        )
                        .order_by(goal_event_outbox.c.created_at)
                        .limit(50)
                        .with_for_update(skip_locked=True)
                    )
                )
                .mappings()
                .all()
            )
            for row in rows:
                await c.execute(
                    update(goal_event_outbox)
                    .where(goal_event_outbox.c.event_id == row["event_id"])
                    .values(
                        claim_owner=owner,
                        claim_until=until,
                        attempts=row["attempts"] + 1,
                    )
                )
        return [dict(row) for row in rows]

    async def finish_goal_event(self, event_id, owner, success):
        now = utc_now()
        async with self._engine.begin() as c:
            await c.execute(
                update(goal_event_outbox)
                .where(
                    goal_event_outbox.c.event_id == event_id,
                    goal_event_outbox.c.claim_owner == owner,
                )
                .values(
                    delivered_at=now if success else None,
                    claim_owner=None,
                    claim_until=None,
                    next_attempt_at=(
                        datetime.now(UTC) + timedelta(seconds=5)
                    ).isoformat(),
                )
            )
            deadline = (datetime.now(UTC) - timedelta(days=7)).isoformat()
            await c.execute(
                delete(goal_event_outbox).where(
                    goal_event_outbox.c.delivered_at < deadline
                )
            )

    async def reserve_goal_creation(self, payload, *, user_id):
        from agent_server.infra.db.schema import runtime_workflows

        request = payload.model_dump(mode="json")
        request["runtimeId"] = payload.runtimeId or payload.runtime
        digest = hashlib.sha256(encode(request).encode()).hexdigest()
        request["attachments"] = [
            {key: value for key, value in ref.items() if key != "contentBase64"}
            for ref in request.get("attachments", [])
        ]
        async with self._engine.begin() as c:
            from sqlalchemy.dialects.postgresql import insert as pg_insert

            values = {
                "user_id": user_id,
                "kind": "goal_creation",
                "id": payload.goalIntent.operationId,
                "connector_id": payload.connectorId,
                "runtime_id": payload.runtimeId or payload.runtime,
                "runtime_type": payload.runtime,
                "project_id": payload.projectId,
                "session_id": None,
                "input_digest": digest,
                "request_json": encode(request),
                "result_json": "{}",
            }
            created = (
                await c.execute(
                    pg_insert(runtime_workflows)
                    .values(**values)
                    .on_conflict_do_nothing()
                    .returning(runtime_workflows.c.id)
                )
            ).scalar_one_or_none()
            if created:
                return None
            old = (
                (
                    await c.execute(
                        select(runtime_workflows).where(
                            runtime_workflows.c.user_id == user_id,
                            runtime_workflows.c.kind == "goal_creation",
                            runtime_workflows.c.id == payload.goalIntent.operationId,
                        )
                    )
                )
                .mappings()
                .one()
            )
            if old["input_digest"] != digest:
                raise ValueError("goal_creation_identity_conflict")
            return json.loads(old["result_json"])

    async def save_goal_creation(self, payload, *, user_id, result):
        from agent_server.infra.db.schema import runtime_workflows

        async with self._engine.begin() as c:
            receipt = (
                await c.execute(
                    select(goal_operations.c.result_payload).where(
                        goal_operations.c.session_id == result["sessionId"],
                        goal_operations.c.operation_id
                        == payload.goalIntent.operationId,
                        goal_operations.c.state.in_(["confirmed", "rejected"]),
                    )
                )
            ).scalar_one_or_none()
            if receipt and "connectorResult" in result:
                confirmed = json.loads(receipt)
                result = {
                    **result,
                    "connectorResult": {
                        **result["connectorResult"],
                        "goal": confirmed,
                        "ok": confirmed["ok"],
                        "messageAccepted": confirmed["ok"],
                    },
                }
            await c.execute(
                update(runtime_workflows)
                .where(
                    runtime_workflows.c.user_id == user_id,
                    runtime_workflows.c.kind == "goal_creation",
                    runtime_workflows.c.id == payload.goalIntent.operationId,
                )
                .values(session_id=result["sessionId"], result_json=encode(result))
            )
