from __future__ import annotations

from agent_server.infra.repositories.store_support import *


class ApprovalRepositoryMixin:
    async def upsert_approval(self, approval: ApprovalIn) -> Approval:
        now = utc_now()
        async with self._engine.begin() as conn:
            existing = (
                await conn.execute(
                    select(approvals_t.c.id).where(
                        approvals_t.c.id == approval.id,
                        approvals_t.c.session_id == approval.sessionId,
                    )
                )
            ).first()
            updated_seq = await self._bump_session(conn, approval.sessionId)
            if existing is None:
                await conn.execute(
                    insert(approvals_t).values(
                        id=approval.id,
                        session_id=approval.sessionId,
                        turn_id=approval.turnId,
                        status=approval.status,
                        kind=approval.kind,
                        target_item_id=approval.targetItemId,
                        title=approval.title,
                        description=approval.description,
                        payload_json=_json_dumps(approval.payload),
                        choices_json=_json_dumps(approval.choices),
                        source_json=_json_dumps(approval.source.model_dump(exclude_none=True)),
                        updated_seq=updated_seq,
                        created_at=approval.createdAt or now,
                        resolved_at=approval.resolvedAt,
                    )
                )
            else:
                await conn.execute(
                    update(approvals_t)
                    .where(
                        approvals_t.c.id == approval.id,
                        approvals_t.c.session_id == approval.sessionId,
                    )
                    .values(
                        turn_id=approval.turnId,
                        status=approval.status,
                        kind=approval.kind,
                        target_item_id=approval.targetItemId,
                        title=approval.title,
                        description=approval.description,
                        payload_json=_json_dumps(approval.payload),
                        choices_json=_json_dumps(approval.choices),
                        source_json=_json_dumps(approval.source.model_dump(exclude_none=True)),
                        updated_seq=updated_seq,
                        resolved_at=approval.resolvedAt,
                    )
                )
        return await self.get_approval(approval.id)


    async def get_approval(self, approval_id: str) -> Approval:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(approvals_t).where(approvals_t.c.id == approval_id)
                )
            ).mappings().first()
        if row is None:
            raise KeyError(approval_id)
        return self._approval_from_row(row)


    async def list_pending_approvals(self, session_id: str) -> list[Approval]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(approvals_t)
                    .where(
                        approvals_t.c.session_id == session_id,
                        approvals_t.c.status == "pending",
                    )
                    .order_by(approvals_t.c.updated_seq.asc())
                )
            ).mappings().all()
        return [self._approval_from_row(row) for row in rows]


    async def resolve_approval(self, approval_id: str, status: str) -> Approval:
        now = utc_now()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(approvals_t.c.session_id).where(approvals_t.c.id == approval_id)
                )
            ).first()
            if row is None:
                raise KeyError(approval_id)
            updated_seq = await self._bump_session(conn, row.session_id)
            await conn.execute(
                update(approvals_t)
                .where(approvals_t.c.id == approval_id)
                .values(status=status, updated_seq=updated_seq, resolved_at=now)
            )
        return await self.get_approval(approval_id)


    def _approval_from_row(self, row: Any) -> Approval:
        return Approval(
            id=row["id"],
            sessionId=row["session_id"],
            turnId=row["turn_id"],
            status=row["status"],
            kind=row["kind"],
            targetItemId=row["target_item_id"],
            title=row["title"],
            description=row["description"],
            payload=_json_loads(row["payload_json"]) or {},
            choices=_json_loads(row["choices_json"]) or [],
            source=_json_loads(row["source_json"]) or {},
            updatedSeq=row["updated_seq"],
            createdAt=row["created_at"],
            resolvedAt=row["resolved_at"],
        )


