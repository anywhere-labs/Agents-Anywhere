from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeModelCatalog,
    RuntimePermissionCatalog,
)
from connector.runtimes.codex.domain.catalogs import (
    codex_permission_catalog_items,
    model_catalog_from_codex_items,
    permission_catalog_from_codex_items,
)
from connector.runtimes.codex.sdk.runtime_client import CodexModelListResult
from connector.runtimes.catalog_revisions import runtime_catalog_revision
from connector.runtimes.custom_models import custom_model_items

EnsureStarted = Callable[[], Awaitable[None]]
GetModelListResult = Callable[[], CodexModelListResult | None]
CODEX_MODEL_CATALOG_STATIC_REVISION = 2
CODEX_PERMISSION_CATALOG_STATIC_REVISION = 1


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
        model_list_result = self.get_model_list_result()
        revision = runtime_catalog_revision(
            self.config.revision,
            CODEX_MODEL_CATALOG_STATIC_REVISION,
        )
        catalog = model_catalog_from_codex_items(
            list(model_list_result.models) if model_list_result is not None else [],
            revision=revision,
        )
        catalog = RuntimeModelCatalog(
            runtime=catalog.runtime,
            revision=revision,
            models=(
                *catalog.models,
                *custom_model_items(
                    "codex",
                    self.config.values.get("customModels"),
                    existing_model_ids={model.id for model in catalog.models},
                ),
            ),
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
        revision = runtime_catalog_revision(
            self.config.revision,
            CODEX_PERMISSION_CATALOG_STATIC_REVISION,
        )
        permissions = permission_catalog_from_codex_items(
            codex_permission_catalog_items(),
            revision=revision,
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
            revision=revision,
            permissions=permissions[:limit],
        )
