from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeModelCatalog,
    RuntimePermissionCatalog,
)
from connector.runtimes.catalog_revisions import runtime_catalog_revision
from connector.runtimes.claude.domain.models import claude_model_catalog
from connector.runtimes.claude.domain.permissions import claude_permission_catalog

CLAUDE_MODEL_CATALOG_STATIC_REVISION = 3
CLAUDE_PERMISSION_CATALOG_STATIC_REVISION = 1


@dataclass(slots=True)
class ClaudeCatalogReader:
    config: RuntimeConfig

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        return claude_model_catalog(
            revision=runtime_catalog_revision(
                self.config.revision,
                CLAUDE_MODEL_CATALOG_STATIC_REVISION,
            ),
            query=query,
            limit=limit,
            custom_models=self.config.values.get("customModels"),
        )

    async def list_permission_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimePermissionCatalog:
        return claude_permission_catalog(
            revision=runtime_catalog_revision(
                self.config.revision,
                CLAUDE_PERMISSION_CATALOG_STATIC_REVISION,
            ),
            query=query,
            limit=limit,
        )

    @property
    def custom_models(self) -> Any:
        return self.config.values.get("customModels")
