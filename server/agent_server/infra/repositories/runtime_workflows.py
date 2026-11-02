from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert

from agent_server.core.runtime_workflows import is_reservation_rejection
from agent_server.infra.db.schema import runtime_workflows


class RuntimeWorkflowRepositoryMixin:
    async def put_runtime_workflow(self, row: dict[str, Any]) -> dict[str, Any]:
        values = {
            **row,
            "request_json": json.dumps(row["request"], ensure_ascii=False),
            "result_json": "{}",
        }
        values.pop("request")
        async with self._engine.begin() as conn:
            await conn.execute(
                insert(runtime_workflows).values(**values).on_conflict_do_nothing()
            )
            current = (
                (
                    await conn.execute(
                        select(runtime_workflows)
                        .where(
                            runtime_workflows.c.user_id == row["user_id"],
                            runtime_workflows.c.kind == row["kind"],
                            runtime_workflows.c.id == row["id"],
                        )
                        .with_for_update()
                    )
                )
                .mappings()
                .one()
            )
            if current["input_digest"] != row["input_digest"]:
                raise ValueError("操作身份已用于不同请求。")
            if row["kind"] == "creation" and not is_reservation_rejection(
                json.loads(current["result_json"])
            ):
                prep = (
                    (
                        await conn.execute(
                            select(runtime_workflows)
                            .where(
                                runtime_workflows.c.user_id == row["user_id"],
                                runtime_workflows.c.kind == "preparation",
                                runtime_workflows.c.id
                                == row["request"]["preparationId"],
                            )
                            .with_for_update()
                        )
                    )
                    .mappings()
                    .first()
                )
                if not prep:
                    raise KeyError(row["request"]["preparationId"])
                if prep["consumed_by"] not in (None, row["id"]):
                    raise ValueError("准备已绑定另一创建操作。")
                await conn.execute(
                    update(runtime_workflows)
                    .where(
                        runtime_workflows.c.user_id == row["user_id"],
                        runtime_workflows.c.kind == "preparation",
                        runtime_workflows.c.id == prep["id"],
                    )
                    .values(consumed_by=row["id"])
                )
        result = await self.get_runtime_workflow(
            row["id"], user_id=row["user_id"], kind=row["kind"]
        )
        if result["input_digest"] != row["input_digest"]:
            raise ValueError("操作身份已用于不同请求。")
        return result

    async def get_runtime_workflow(
        self, identifier: str, *, user_id: str, kind: str
    ) -> dict[str, Any]:
        async with self._engine.connect() as conn:
            row = (
                (
                    await conn.execute(
                        select(runtime_workflows).where(
                            runtime_workflows.c.id == identifier,
                            runtime_workflows.c.user_id == user_id,
                            runtime_workflows.c.kind == kind,
                        )
                    )
                )
                .mappings()
                .first()
            )
        if not row:
            raise KeyError(identifier)
        value = dict(row)
        value["request"] = json.loads(value.pop("request_json"))
        value["result"] = json.loads(value.pop("result_json"))
        return value

    async def set_runtime_workflow_result(
        self, identifier: str, *, user_id: str, kind: str, result: dict[str, Any]
    ) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                update(runtime_workflows)
                .where(
                    runtime_workflows.c.id == identifier,
                    runtime_workflows.c.user_id == user_id,
                    runtime_workflows.c.kind == kind,
                )
                .values(result_json=json.dumps(result, ensure_ascii=False))
            )

    async def reject_unreserved_creation(
        self, identifier: str, *, user_id: str, result: dict[str, Any]
    ) -> dict[str, Any]:
        if not is_reservation_rejection(result):
            raise ValueError("只有明确未预留的拒绝才能释放准备。")
        async with self._engine.begin() as conn:
            condition = (
                runtime_workflows.c.id == identifier,
                runtime_workflows.c.user_id == user_id,
                runtime_workflows.c.kind == "creation",
            )
            row = (
                (
                    await conn.execute(
                        select(runtime_workflows).where(*condition).with_for_update()
                    )
                )
                .mappings()
                .one()
            )
            old = json.loads(row["result_json"])
            if old and not is_reservation_rejection(old):
                raise ValueError("已进入 Runtime 创建阶段，不能释放准备。")
            result = old or result
            prep_id = json.loads(row["request_json"])["preparationId"]
            await conn.execute(
                select(runtime_workflows)
                .where(
                    runtime_workflows.c.id == prep_id,
                    runtime_workflows.c.user_id == user_id,
                    runtime_workflows.c.kind == "preparation",
                )
                .with_for_update()
            )
            await conn.execute(
                update(runtime_workflows)
                .where(*condition)
                .values(result_json=json.dumps(result, ensure_ascii=False))
            )
            await conn.execute(
                update(runtime_workflows)
                .where(
                    runtime_workflows.c.id == prep_id,
                    runtime_workflows.c.user_id == user_id,
                    runtime_workflows.c.kind == "preparation",
                    runtime_workflows.c.consumed_by == identifier,
                )
                .values(consumed_by=None)
            )
        return result
