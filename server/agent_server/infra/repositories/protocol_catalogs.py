from __future__ import annotations

from typing import Any

from agent_server.infra.repositories.store_support import *


class ProtocolCatalogRepositoryMixin:
    async def update_protocol_catalog(
        self,
        connector_id: str,
        *,
        runtime: str,
        catalog_type: str,
        revision: int,
        catalog: dict[str, Any],
    ) -> None:
        now = utc_now()
        async with self._engine.begin() as conn:
            row = (
                await conn.execute(
                    select(connectors_t.c.id).where(
                        connectors_t.c.id == connector_id,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
            if row is None:
                raise KeyError(connector_id)
            existing = (
                await conn.execute(
                    select(connector_runtime_catalogs_t.c.revision).where(
                        connector_runtime_catalogs_t.c.connector_id == connector_id,
                        connector_runtime_catalogs_t.c.runtime == runtime,
                        connector_runtime_catalogs_t.c.catalog_type == catalog_type,
                    )
                )
            ).first()
            if existing is not None and int(existing.revision) > revision:
                return
            values = {
                "connector_id": connector_id,
                "runtime": runtime,
                "catalog_type": catalog_type,
                "revision": revision,
                "catalog_json": _json_dumps(catalog),
                "updated_at": now,
            }
            if existing is None:
                await conn.execute(insert(connector_runtime_catalogs_t).values(**values))
            else:
                await conn.execute(
                    update(connector_runtime_catalogs_t)
                    .where(
                        connector_runtime_catalogs_t.c.connector_id == connector_id,
                        connector_runtime_catalogs_t.c.runtime == runtime,
                        connector_runtime_catalogs_t.c.catalog_type == catalog_type,
                    )
                    .values(**values)
                )

    async def get_protocol_catalog(
        self,
        connector_id: str,
        *,
        runtime: str,
        catalog_type: str,
        user_id: str | None = None,
    ) -> dict[str, Any] | None:
        if user_id is not None:
            connector = await self.get_connector(connector_id)
            if connector.userId != user_id:
                raise KeyError(connector_id)
        async with self._engine.connect() as conn:
            row = (
                await conn.execute(
                    select(connector_runtime_catalogs_t.c.catalog_json)
                    .select_from(
                        connector_runtime_catalogs_t.join(
                            connectors_t,
                            connector_runtime_catalogs_t.c.connector_id == connectors_t.c.id,
                        )
                    )
                    .where(
                        connector_runtime_catalogs_t.c.connector_id == connector_id,
                        connector_runtime_catalogs_t.c.runtime == runtime,
                        connector_runtime_catalogs_t.c.catalog_type == catalog_type,
                        connectors_t.c.revoked == 0,
                    )
                )
            ).first()
        if row is None:
            return None
        data = _json_loads(row.catalog_json)
        return data if isinstance(data, dict) else None
