from __future__ import annotations

from agent_server.infra.repositories.store_support import *


class AgentCatalogRepositoryMixin:
    async def seed_agent_catalog(self) -> None:
        """Insert any catalog rows declared in SEED_AGENT_CATALOG that are
        missing. Idempotent: re-running is a no-op once a row is present.
        Existing rows are NOT updated, so operators can safely edit labels in
        the DB without seeding overwriting them on next boot.
        """
        await self._seed_table(agent_modes_t, SEED_AGENT_MODES)
        await self._seed_table(agent_models_t, SEED_AGENT_MODELS)
        await self._seed_table(agent_efforts_t, SEED_AGENT_EFFORTS)


    async def _seed_table(self, table: Any, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        async with self._engine.begin() as conn:
            existing = (
                await conn.execute(
                    select(table.c.runtime, table.c.key).where(
                        table.c.runtime.in_({row["runtime"] for row in rows})
                    )
                )
            ).all()
            present = {(r.runtime, r.key) for r in existing}
            missing = [row for row in rows if (row["runtime"], row["key"]) not in present]
            if not missing:
                return
            await conn.execute(insert(table), missing)

    # --- runtime config schema / settings ------------------------------------


    async def list_agent_modes(self, runtime: str) -> list[AgentCatalogEntry]:
        return await self._list_agent_catalog(agent_modes_t, runtime)


    async def list_agent_models(self, runtime: str) -> list[AgentCatalogEntry]:
        return await self._list_agent_catalog(agent_models_t, runtime)


    async def list_agent_efforts(self, runtime: str) -> list[AgentCatalogEntry]:
        return await self._list_agent_catalog(agent_efforts_t, runtime)


    async def _list_agent_catalog(self, table: Any, runtime: str) -> list[AgentCatalogEntry]:
        async with self._engine.connect() as conn:
            rows = (
                await conn.execute(
                    select(table)
                    .where(table.c.runtime == runtime)
                    .order_by(table.c.sort_order.asc(), table.c.key.asc())
                )
            ).mappings().all()
        return [
            AgentCatalogEntry(
                runtime=row["runtime"],
                key=row["key"],
                displayLabel=row["display_label"],
                description=row["description"],
                isDefault=bool(row["is_default"]),
                sortOrder=int(row["sort_order"]),
            )
            for row in rows
        ]

    # --- connector preferences ------------------------------------------------

