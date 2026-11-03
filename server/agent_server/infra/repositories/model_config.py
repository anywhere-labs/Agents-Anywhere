from __future__ import annotations

from typing import Any

from sqlalchemy import and_, delete, func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from agent_server.core.utc import utc_now
from agent_server.infra.db.schema import (
    connectors,
    device_runtimes,
    model_config_operations,
    model_profiles,
    runtime_model_assignments,
)
from agent_server.infra.repositories.store_support import _json_dumps, _json_loads


class ModelProfileInUseError(RuntimeError):
    pass


class ModelConfigRepositoryMixin:
    # Profiles.

    async def create_model_profile(self, row: dict[str, Any]) -> dict[str, Any]:
        async with self._engine.begin() as conn:
            await conn.execute(insert(model_profiles).values(**row))
        return await self.get_model_profile(row["id"], user_id=row["user_id"])

    async def get_model_profile(self, profile_id: str, *, user_id: str) -> dict[str, Any]:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(model_profiles).where(
                        model_profiles.c.id == profile_id,
                        model_profiles.c.user_id == user_id,
                    )
                )
            ).mappings().first()
        if row is None:
            raise KeyError(profile_id)
        return _profile_row(row)

    async def list_model_profiles(self, *, user_id: str) -> list[dict[str, Any]]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(model_profiles)
                    .where(model_profiles.c.user_id == user_id)
                    .order_by(model_profiles.c.created_at, model_profiles.c.id)
                )
            ).mappings().all()
        return [_profile_row(row) for row in rows]

    async def find_model_profile_by_source(
        self, *, user_id: str, source: str
    ) -> dict[str, Any] | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(model_profiles).where(
                        model_profiles.c.user_id == user_id,
                        model_profiles.c.source == source,
                    )
                )
            ).mappings().first()
        return _profile_row(row) if row is not None else None

    async def update_model_profile(
        self,
        profile_id: str,
        *,
        user_id: str,
        values: dict[str, Any],
        expected_etag: int | None = None,
    ) -> dict[str, Any]:
        """Update a profile; with ``expected_etag`` only if nobody else did."""
        conditions = [model_profiles.c.id == profile_id, model_profiles.c.user_id == user_id]
        if expected_etag is not None:
            conditions.append(model_profiles.c.etag == expected_etag)
        async with self._engine.begin() as conn:
            result = await conn.execute(
                update(model_profiles)
                .where(*conditions)
                .values(**values, etag=model_profiles.c.etag + 1, updated_at=utc_now())
            )
            if result.rowcount == 0:
                exists = (
                    await conn.execute(
                        select(model_profiles.c.id).where(
                            model_profiles.c.id == profile_id,
                            model_profiles.c.user_id == user_id,
                        )
                    )
                ).first()
                if exists is None:
                    raise KeyError(profile_id)
                raise ValueError("profile changed")
        return await self.get_model_profile(profile_id, user_id=user_id)

    async def delete_model_profile(self, profile_id: str, *, user_id: str) -> None:
        async with self._engine.begin() as conn:
            in_use = (
                await conn.execute(
                    select(func.count())
                    .select_from(runtime_model_assignments)
                    .where(runtime_model_assignments.c.profile_id == profile_id)
                )
            ).scalar_one()
            if in_use:
                raise ModelProfileInUseError(profile_id)
            result = await conn.execute(
                delete(model_profiles).where(
                    model_profiles.c.id == profile_id,
                    model_profiles.c.user_id == user_id,
                )
            )
            if result.rowcount == 0:
                raise KeyError(profile_id)

    # Assignments.

    async def get_runtime_assignment(
        self, connector_id: str, runtime_id: str
    ) -> dict[str, Any] | None:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(runtime_model_assignments).where(
                        runtime_model_assignments.c.connector_id == connector_id,
                        runtime_model_assignments.c.runtime_id == runtime_id,
                    )
                )
            ).mappings().first()
        return _assignment_row(row) if row is not None else None

    async def list_runtime_assignments(self, *, user_id: str) -> list[dict[str, Any]]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(runtime_model_assignments)
                    .join(connectors, connectors.c.id == runtime_model_assignments.c.connector_id)
                    .where(connectors.c.user_id == user_id)
                    .order_by(
                        runtime_model_assignments.c.connector_id,
                        runtime_model_assignments.c.runtime_id,
                    )
                )
            ).mappings().all()
        return [_assignment_row(row) for row in rows]

    async def list_deferred_runtime_assignments(self) -> list[dict[str, Any]]:
        """Assignments saved while tasks ran, waiting for the runtime to be idle."""
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(runtime_model_assignments, connectors.c.user_id)
                    .join(connectors, connectors.c.id == runtime_model_assignments.c.connector_id)
                    .where(runtime_model_assignments.c.status == "deferred")
                )
            ).mappings().all()
        return [{**_assignment_row(row), "userId": row["user_id"]} for row in rows]

    async def set_runtime_assignment_status(self, connector_id: str, runtime_id: str, status: str) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                update(runtime_model_assignments)
                .where(
                    runtime_model_assignments.c.connector_id == connector_id,
                    runtime_model_assignments.c.runtime_id == runtime_id,
                )
                .values(status=status, error_json=None, updated_at=utc_now())
            )

    async def save_runtime_assignment(self, row: dict[str, Any]) -> None:
        values = {
            key: value for key, value in row.items() if key not in {"imported_model_ids", "error"}
        }
        values["imported_model_ids_json"] = _json_dumps(row["imported_model_ids"])
        values["error_json"] = _json_dumps(row["error"]) if row.get("error") else None
        values["updated_at"] = utc_now()
        async with self._engine.begin() as conn:
            statement = pg_insert(runtime_model_assignments).values(**values)
            await conn.execute(
                statement.on_conflict_do_update(
                    index_elements=["connector_id", "runtime_id"],
                    set_={
                        key: statement.excluded[key]
                        for key in values
                        if key not in {"connector_id", "runtime_id"}
                    },
                )
            )

    async def set_runtime_assignment_failed(
        self, connector_id: str, runtime_id: str, error: dict[str, Any]
    ) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                update(runtime_model_assignments)
                .where(
                    runtime_model_assignments.c.connector_id == connector_id,
                    runtime_model_assignments.c.runtime_id == runtime_id,
                )
                .values(status="failed", error_json=_json_dumps(error), updated_at=utc_now())
            )

    async def delete_runtime_assignment(
        self, connector_id: str, runtime_id: str
    ) -> None:
        """Delete an assignment, and its profile once a detached one is unused."""
        async with self._engine.begin() as conn:
            profile_id = (
                await conn.execute(
                    delete(runtime_model_assignments)
                    .where(
                        runtime_model_assignments.c.connector_id == connector_id,
                        runtime_model_assignments.c.runtime_id == runtime_id,
                    )
                    .returning(runtime_model_assignments.c.profile_id)
                )
            ).scalar_one_or_none()
            if profile_id is None:
                return
            remaining = (
                await conn.execute(
                    select(func.count())
                    .select_from(runtime_model_assignments)
                    .where(runtime_model_assignments.c.profile_id == profile_id)
                )
            ).scalar_one()
            if not remaining:
                await conn.execute(
                    delete(model_profiles).where(
                        model_profiles.c.id == profile_id,
                        model_profiles.c.state == "detached",
                    )
                )

    # Instances the model configuration created.

    async def set_device_runtime_managed_by(
        self, connector_id: str, runtime_id: str, managed_by: str | None
    ) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                update(device_runtimes)
                .where(
                    device_runtimes.c.connector_id == connector_id,
                    device_runtimes.c.runtime_id == runtime_id,
                )
                .values(managed_by=managed_by)
            )

    async def find_managed_runtime_id(
        self, connector_id: str, runtime_type: str, managed_by: str
    ) -> str | None:
        async with self._engine.connect() as conn:
            return (
                await conn.execute(
                    select(device_runtimes.c.runtime_id)
                    .where(
                        device_runtimes.c.connector_id == connector_id,
                        device_runtimes.c.runtime_type == runtime_type,
                        device_runtimes.c.managed_by == managed_by,
                    )
                    .order_by(device_runtimes.c.created_at)
                    .limit(1)
                )
            ).scalar_one_or_none()

    # Operations.

    async def start_model_config_operation(self, row: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        """Insert an operation, or return the one with the same idempotency key.

        The second value is True when this call created it.
        """
        values = {key: value for key, value in row.items() if key != "targets"}
        values["targets_json"] = _json_dumps(row["targets"])
        async with self._engine.begin() as conn:
            inserted = (
                await conn.execute(
                    pg_insert(model_config_operations)
                    .values(**values)
                    .on_conflict_do_nothing(index_elements=["user_id", "idempotency_key"])
                    .returning(model_config_operations.c.id)
                )
            ).scalar_one_or_none()
            existing = (
                await conn.execute(
                    select(model_config_operations).where(
                        model_config_operations.c.user_id == values["user_id"],
                        model_config_operations.c.idempotency_key == values["idempotency_key"],
                    )
                )
            ).mappings().first()
        assert existing is not None
        return _operation_row(existing), inserted is not None

    async def get_model_config_operation(self, operation_id: str, *, user_id: str) -> dict[str, Any]:
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(model_config_operations).where(
                        model_config_operations.c.id == operation_id,
                        model_config_operations.c.user_id == user_id,
                    )
                )
            ).mappings().first()
        if row is None:
            raise KeyError(operation_id)
        return _operation_row(row)

    async def update_model_config_operation(
        self,
        operation_id: str,
        *,
        targets: list[dict[str, Any]] | None = None,
        result: dict[str, Any] | None = None,
        finished: bool = False,
    ) -> None:
        values: dict[str, Any] = {}
        if targets is not None:
            values["targets_json"] = _json_dumps(targets)
        if result is not None:
            values["result_json"] = _json_dumps(result)
        if finished:
            values["finished_at"] = utc_now()
        if not values:
            return
        async with self._engine.begin() as conn:
            await conn.execute(
                update(model_config_operations)
                .where(model_config_operations.c.id == operation_id)
                .values(**values)
            )

    async def list_running_model_config_operations(self, *, user_id: str, now: str) -> list[dict[str, Any]]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(model_config_operations).where(
                        and_(
                            model_config_operations.c.user_id == user_id,
                            model_config_operations.c.finished_at.is_(None),
                            model_config_operations.c.lease_until > now,
                        )
                    )
                )
            ).mappings().all()
        return [_operation_row(row) for row in rows]

    async def prune_model_config_operations(self, *, before: str) -> None:
        async with self._engine.begin() as conn:
            await conn.execute(
                delete(model_config_operations).where(
                    model_config_operations.c.finished_at.is_not(None),
                    model_config_operations.c.finished_at < before,
                )
            )


def _profile_row(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "source": row["source"],
        "name": row["name"],
        "originHost": row["origin_host"],
        "offers": _json_loads(row["offers_json"]) or [],
        "catalogDigest": row["catalog_digest"],
        "keyRef": _json_loads(row["key_ref_json"]) or {},
        "secretCiphertext": row["secret_ciphertext"],
        "preferences": _json_loads(row["preferences_json"]),
        "state": row["state"],
        "etag": row["etag"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _assignment_row(row: Any) -> dict[str, Any]:
    return {
        "connectorId": row["connector_id"],
        "runtimeId": row["runtime_id"],
        "profileId": row["profile_id"],
        "offerFormat": row["offer_format"],
        "createdRuntime": bool(row["created_runtime"]),
        "appliedDigest": row["applied_digest"],
        "appliedCatalogDigest": row["applied_catalog_digest"],
        "importedModelIds": _json_loads(row["imported_model_ids_json"]) or [],
        "previousGatewayCiphertext": row["previous_gateway_ciphertext"],
        "status": row["status"],
        "error": _json_loads(row["error_json"]),
        "appliedAt": row["applied_at"],
        "updatedAt": row["updated_at"],
    }


def _operation_row(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "kind": row["kind"],
        "idempotencyKey": row["idempotency_key"],
        "requestDigest": row["request_digest"],
        "targets": _json_loads(row["targets_json"]) or [],
        "leaseUntil": row["lease_until"],
        "result": _json_loads(row["result_json"]),
        "createdAt": row["created_at"],
        "finishedAt": row["finished_at"],
    }
