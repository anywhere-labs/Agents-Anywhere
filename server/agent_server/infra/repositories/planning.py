from __future__ import annotations

import json

from sqlalchemy import insert, select, update

from agent_server.core.utc import utc_now
from agent_server.infra.db.schema import (
    connectors,
    plan_documents,
    planning_creations,
    planning_operations,
    session_planning,
    sessions,
)


class PlanningRepositoryMixin:
    async def save_planning(self, session_id: str, state: dict) -> bool:
        async with self._engine.begin() as conn:
            await conn.execute(
                select(sessions.c.id)
                .where(sessions.c.id == session_id)
                .with_for_update()
            )
            old = (
                await conn.execute(
                    select(session_planning.c.payload).where(
                        session_planning.c.session_id == session_id
                    )
                )
            ).scalar_one_or_none()
            documents = [
                *state.get("proposals", []),
                *([state["proposal"]] if state.get("proposal") else []),
            ]
            for document in documents:
                target = (
                    plan_documents.c.session_id == session_id,
                    plan_documents.c.plan_id == document["planId"],
                    plan_documents.c.revision == document["revision"],
                )
                existing = (
                    await conn.execute(
                        select(plan_documents.c.content_hash).where(*target)
                    )
                ).scalar_one_or_none()
                if existing and existing != document["contentHash"]:
                    raise ValueError("An immutable plan revision cannot change")
                if existing is None:
                    await conn.execute(
                        insert(plan_documents).values(
                            session_id=session_id,
                            plan_id=document["planId"],
                            revision=document["revision"],
                            content_hash=document["contentHash"],
                            payload=json.dumps(document, ensure_ascii=False),
                            created_at=utc_now(),
                        )
                    )
            if old:
                previous = json.loads(old)
                if previous.get("epoch") == state.get("epoch") and previous.get(
                    "revision", 0
                ) > state.get("revision", 0):
                    return False
            # Documents have their own durable store, current state is only a projection.
            payload = json.dumps(
                {k: v for k, v in state.items() if k != "proposals"}, ensure_ascii=False
            )
            if old is None:
                await conn.execute(
                    insert(session_planning).values(
                        session_id=session_id, payload=payload
                    )
                )
            else:
                await conn.execute(
                    update(session_planning)
                    .where(session_planning.c.session_id == session_id)
                    .values(payload=payload)
                )
        return True

    async def read_planning(self, session_id: str) -> dict | None:
        async with self._engine.connect() as conn:
            value = (
                await conn.execute(
                    select(session_planning.c.payload).where(
                        session_planning.c.session_id == session_id
                    )
                )
            ).scalar_one_or_none()
        return json.loads(value) if value else None

    async def list_plan_documents(self, session_id: str) -> list[dict]:
        async with self._engine.connect() as conn:
            rows = (
                (
                    await conn.execute(
                        select(plan_documents.c.payload)
                        .where(plan_documents.c.session_id == session_id)
                        .order_by(
                            plan_documents.c.created_at, plan_documents.c.revision
                        )
                    )
                )
                .scalars()
                .all()
            )
        return [json.loads(row) for row in rows]

    async def get_plan_document(
        self, session_id: str, plan_id: str, revision: int
    ) -> dict:
        async with self._engine.connect() as conn:
            value = (
                await conn.execute(
                    select(plan_documents.c.payload).where(
                        plan_documents.c.session_id == session_id,
                        plan_documents.c.plan_id == plan_id,
                        plan_documents.c.revision == revision,
                    )
                )
            ).scalar_one_or_none()
        if value is None:
            raise KeyError(plan_id)
        return json.loads(value)

    async def reserve_planning_operation(
        self, session_id: str, operation_id: str, fingerprint: str
    ) -> dict | None:
        async with self._engine.begin() as conn:
            await conn.execute(
                select(sessions.c.id)
                .where(sessions.c.id == session_id)
                .with_for_update()
            )
            row = (
                (
                    await conn.execute(
                        select(planning_operations).where(
                            planning_operations.c.session_id == session_id,
                            planning_operations.c.operation_id == operation_id,
                        )
                    )
                )
                .mappings()
                .first()
            )
            if row:
                if row["fingerprint"] != fingerprint:
                    raise ValueError("同一操作身份不能用于不同请求。")
                return json.loads(row["payload"])
            pending = {
                "operationId": operation_id,
                "outcome": "unknown",
                "ok": False,
                "code": "command_outcome_unknown",
                "message": "操作已受理，正在核对原生结果。",
                "retryable": False,
            }
            await conn.execute(
                insert(planning_operations).values(
                    session_id=session_id,
                    operation_id=operation_id,
                    fingerprint=fingerprint,
                    payload=json.dumps(pending),
                )
            )
        return None

    async def get_planning_operation(
        self, session_id: str, operation_id: str
    ) -> dict | None:
        async with self._engine.connect() as conn:
            value = (
                await conn.execute(
                    select(planning_operations.c.payload).where(
                        planning_operations.c.session_id == session_id,
                        planning_operations.c.operation_id == operation_id,
                    )
                )
            ).scalar_one_or_none()
        return json.loads(value) if value else None

    async def save_planning_operation(
        self, session_id: str, operation_id: str, result: dict
    ) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                update(planning_operations)
                .where(
                    planning_operations.c.session_id == session_id,
                    planning_operations.c.operation_id == operation_id,
                )
                .values(payload=json.dumps(result, ensure_ascii=False))
            )

    async def reserve_planning_creation(
        self, connector_id: str, runtime_id: str, operation_id: str, fingerprint: str
    ) -> dict | None:
        async with self._engine.begin() as conn:
            await conn.execute(
                select(connectors.c.id)
                .where(connectors.c.id == connector_id)
                .with_for_update()
            )
            target = (
                planning_creations.c.connector_id == connector_id,
                planning_creations.c.runtime_id == runtime_id,
                planning_creations.c.operation_id == operation_id,
            )
            row = (
                (await conn.execute(select(planning_creations).where(*target)))
                .mappings()
                .first()
            )
            if row:
                if row["fingerprint"] != fingerprint:
                    raise ValueError("同一创建身份不能用于不同的规划任务。")
                return json.loads(row["payload"])
            await conn.execute(
                insert(planning_creations).values(
                    connector_id=connector_id,
                    runtime_id=runtime_id,
                    operation_id=operation_id,
                    fingerprint=fingerprint,
                    payload="{}",
                )
            )
        return None

    async def save_planning_creation(
        self, connector_id: str, runtime_id: str, operation_id: str, payload: dict
    ) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                update(planning_creations)
                .where(
                    planning_creations.c.connector_id == connector_id,
                    planning_creations.c.runtime_id == runtime_id,
                    planning_creations.c.operation_id == operation_id,
                )
                .values(payload=json.dumps(payload, ensure_ascii=False))
            )
