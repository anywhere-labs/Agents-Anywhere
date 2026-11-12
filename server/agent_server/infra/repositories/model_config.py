from __future__ import annotations

from typing import Any

from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from agent_server.core.utc import utc_now
from agent_server.infra.db.schema import (
    connectors,
    device_runtimes,
    model_channel_selections,
    model_profiles,
    runtime_channel_overrides,
    runtime_channel_switches,
    runtime_model_assignments,
)
from agent_server.infra.repositories.channel_reconciliation import channel_connection
from agent_server.infra.repositories.store_support import _json_dumps, _json_loads


class ModelProfileInUseError(RuntimeError):
    pass


class ModelConfigRepositoryMixin:
    # Profiles.

    async def create_model_profile(self, row: dict[str, Any]) -> dict[str, Any]:
        async with self.channel_transaction(row["user_id"]):
            async with channel_connection(self, write=True) as conn:
                await conn.execute(insert(model_profiles).values(**row))
            await self._refresh_channel_targets(row["user_id"])
        return await self.get_model_profile(row["id"], user_id=row["user_id"])

    async def get_model_profile(self, profile_id: str, *, user_id: str) -> dict[str, Any]:
        async with channel_connection(self) as conn:
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
        async with channel_connection(self) as conn:
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
        async with channel_connection(self) as conn:
            row = (
                await conn.execute(
                    select(model_profiles).where(
                        model_profiles.c.user_id == user_id,
                        model_profiles.c.source == source,
                    )
                )
            ).mappings().first()
        return _profile_row(row) if row is not None else None

    async def update_model_profile(self, profile_id: str, *, user_id: str, values: dict[str, Any],
                                   expected_etag: int | None = None) -> dict[str, Any]:
        async with self.channel_transaction(user_id):
            async with channel_connection(self, write=True) as conn:
                row = (await conn.execute(select(model_profiles).where(
                    model_profiles.c.id == profile_id, model_profiles.c.user_id == user_id,
                ).with_for_update())).mappings().first()
                if row is None:
                    raise KeyError(profile_id)
                if expected_etag is not None and row["etag"] != expected_etag:
                    raise ValueError("profile changed")
                values = dict(values)
                if any(k in values and values[k] != row[k] for k in (
                    "catalog_digest", "origin_host", "key_ref_json", "preferences_json", "state")):
                    values["connection_revision"] = row["connection_revision"] + 1
                await conn.execute(update(model_profiles).where(model_profiles.c.id == profile_id).values(
                    **values, etag=model_profiles.c.etag + 1, updated_at=utc_now()))
                await self._refresh_channel_targets(user_id)
            return await self.get_model_profile(profile_id, user_id=user_id)

    async def delete_model_profile(self, profile_id: str, *, user_id: str) -> None:
        async with self.channel_transaction(user_id), channel_connection(self, write=True) as conn:
            selected = (await conn.execute(select(model_channel_selections.c.user_id).where(
                model_channel_selections.c.user_id == user_id, model_channel_selections.c.channel == profile_id))).first()
            pinned = (await conn.execute(select(runtime_channel_overrides.c.runtime_id).join(
                connectors, connectors.c.id == runtime_channel_overrides.c.connector_id).where(
                connectors.c.user_id == user_id, runtime_channel_overrides.c.channel == profile_id))).first()
            executing = (await conn.execute(select(runtime_channel_switches.c.runtime_id).where(
                runtime_channel_switches.c.user_id == user_id, runtime_channel_switches.c.target_channel == profile_id,
                runtime_channel_switches.c.state.in_(("switching", "restoring", "failed"))))).first()
            if selected or pinned or executing:
                raise ModelProfileInUseError(profile_id)
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
        async with channel_connection(self) as conn:
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
        async with channel_connection(self) as conn:
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

    async def save_runtime_assignment(self, row: dict[str, Any]) -> None:
        values = {
            key: value for key, value in row.items() if key not in {"imported_model_ids", "error"}
        }
        values["imported_model_ids_json"] = _json_dumps(row["imported_model_ids"])
        values["error_json"] = _json_dumps(row["error"]) if row.get("error") else None
        values["updated_at"] = utc_now()
        async with channel_connection(self, write=True) as conn:
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

    async def delete_runtime_assignment(
        self, connector_id: str, runtime_id: str
    ) -> None:
        """Delete an assignment, and its profile once a detached one is unused."""
        async with channel_connection(self, write=True) as conn:
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
        async with channel_connection(self, write=True) as conn:
            await conn.execute(
                update(device_runtimes)
                .where(
                    device_runtimes.c.connector_id == connector_id,
                    device_runtimes.c.runtime_id == runtime_id,
                )
                .values(managed_by=managed_by)
            )

    async def find_managed_runtime_id(
        self, connector_id: str, runtime_type: str, managed_by: str, *, legacy_only: bool = False
    ) -> str | None:
        async with channel_connection(self) as conn:
            return (
                await conn.execute(
                    select(device_runtimes.c.runtime_id)
                    .where(
                        device_runtimes.c.connector_id == connector_id,
                        device_runtimes.c.runtime_type == runtime_type,
                        device_runtimes.c.managed_by == managed_by,
                        ~device_runtimes.c.runtime_id.startswith("rti_channel_", autoescape=True) if legacy_only else True,
                    )
                    .order_by(device_runtimes.c.created_at)
                    .limit(1)
                )
            ).scalar_one_or_none()


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
        "connectionRevision": row["connection_revision"],
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
