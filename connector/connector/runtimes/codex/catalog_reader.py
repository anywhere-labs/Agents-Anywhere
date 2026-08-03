from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeModelCatalog,
    RuntimePermissionCatalog,
)
from connector.runtimes.codex import sessions as codex_sessions
from connector.runtimes.codex.catalogs import (
    codex_permission_catalog_items,
    model_catalog_from_codex_items,
    permission_catalog_from_codex_items,
)

EnsureStarted = Callable[[], Awaitable[None]]
GetModelListResult = Callable[[], dict[str, Any] | None]


@dataclass(slots=True)
class CodexCatalogReader:
    config: RuntimeConfig
    ensure_started: EnsureStarted
    get_model_list_result: GetModelListResult

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        await self.ensure_started()
        catalog = model_catalog_from_codex_items(
            codex_sessions.model_list_items(self.get_model_list_result()),
            revision=self.config.revision,
        )
        if query:
            lowered = query.casefold()
            models = tuple(
                model
                for model in catalog.models
                if lowered in model.id.casefold() or lowered in model.title.casefold()
            )
        else:
            models = catalog.models
        return RuntimeModelCatalog(
            runtime=catalog.runtime,
            revision=catalog.revision,
            models=models[:limit],
        )

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        permissions = permission_catalog_from_codex_items(
            codex_permission_catalog_items(),
            revision=self.config.revision,
        ).permissions
        if query:
            lowered = query.casefold()
            permissions = tuple(
                item
                for item in permissions
                if lowered in item.id.casefold() or lowered in item.title.casefold()
            )
        return RuntimePermissionCatalog(
            runtime="codex",
            revision=self.config.revision,
            permissions=permissions[:limit],
        )
