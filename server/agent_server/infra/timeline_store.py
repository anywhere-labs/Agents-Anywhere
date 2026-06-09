from __future__ import annotations

import json
from typing import Any

from sqlalchemy import delete, insert
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

from agent_server.infra.db import timeline_items
from agent_server.infra.db.engine import SQLITE_BACKEND
from agent_server.core.models import TimelineItem


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


class SqlTimelineStore:
    def __init__(self, engine: AsyncEngine, *, backend: str = SQLITE_BACKEND) -> None:
        self._engine = engine
        self._backend = backend

    async def read(self, session_id: str) -> list[TimelineItem]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    timeline_items.select()
                    .where(timeline_items.c.session_id == session_id)
                    .order_by(
                        timeline_items.c.order_seq,
                        timeline_items.c.updated_seq,
                        timeline_items.c.id,
                    )
                )
            ).mappings().all()
        return [TimelineItem.model_validate_json(row["payload_json"]) for row in rows]

    async def replace(self, session_id: str, items: list[TimelineItem]) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                delete(timeline_items).where(timeline_items.c.session_id == session_id)
            )
            if items:
                sorted_items = sorted(
                    items, key=lambda value: (value.orderSeq, value.updatedSeq, value.id)
                )
                await conn.execute(
                    insert(timeline_items),
                    [self._row_values(item) for item in sorted_items],
                )

    async def latest_item(self, session_id: str) -> TimelineItem | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    timeline_items.select()
                    .where(timeline_items.c.session_id == session_id)
                    .order_by(
                        timeline_items.c.item_time.desc(),
                        timeline_items.c.order_seq.desc(),
                        timeline_items.c.updated_seq.desc(),
                    )
                    .limit(1)
                )
            ).mappings().first()
        return TimelineItem.model_validate_json(row["payload_json"]) if row is not None else None

    async def upsert_one(self, conn: AsyncConnection, item: TimelineItem) -> None:
        """Insert-or-update a single row by composite PK (session_id, id).

        Hot path: called per streaming Codex delta. Avoids the O(N) DELETE-all
        + INSERT-all pattern that `replace()` does. The dialect-specific
        upsert keeps it to one row mutation.
        """
        values = self._row_values(item)
        if self._backend == SQLITE_BACKEND:
            stmt = sqlite_insert(timeline_items).values(**values)
            update_cols = {k: stmt.excluded[k] for k in values if k not in ("session_id", "id")}
            stmt = stmt.on_conflict_do_update(
                index_elements=["session_id", "id"], set_=update_cols
            )
        else:
            stmt = pg_insert(timeline_items).values(**values)
            update_cols = {k: stmt.excluded[k] for k in values if k not in ("session_id", "id")}
            stmt = stmt.on_conflict_do_update(
                index_elements=["session_id", "id"], set_=update_cols
            )
        await conn.execute(stmt)

    async def read_one(
        self, session_id: str, item_id: str
    ) -> TimelineItem | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    timeline_items.select().where(
                        timeline_items.c.session_id == session_id,
                        timeline_items.c.id == item_id,
                    )
                )
            ).mappings().first()
        return TimelineItem.model_validate_json(row["payload_json"]) if row is not None else None

    async def list_since(
        self, session_id: str, *, after_seq: int, limit: int
    ) -> tuple[list[TimelineItem], bool]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    timeline_items.select()
                    .where(
                        timeline_items.c.session_id == session_id,
                        timeline_items.c.updated_seq > after_seq,
                    )
                    .order_by(timeline_items.c.updated_seq)
                    .limit(limit + 1)
                )
            ).mappings().all()
        has_more = len(rows) > limit
        items = [TimelineItem.model_validate_json(row["payload_json"]) for row in rows[:limit]]
        return items, has_more

    def _row_values(self, item: TimelineItem) -> dict[str, Any]:
        return {
            "session_id": item.sessionId,
            "id": item.id,
            "type": item.type,
            "status": item.status,
            "role": item.role,
            "turn_id": item.turnId,
            "order_seq": item.orderSeq,
            "updated_seq": item.updatedSeq,
            "item_time": _item_time(item),
            "payload_json": _json_dumps(item.model_dump(exclude_none=True)),
        }


def _item_time(item: TimelineItem) -> str | None:
    values = [value for value in (item.createdAt, item.completedAt, item.updatedAt) if value]
    return max(values) if values else None
