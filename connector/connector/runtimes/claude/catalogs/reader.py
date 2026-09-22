from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimePermissionCatalog,
)
from connector.runtimes.catalog_revisions import runtime_catalog_revision
from connector.runtimes.claude.catalogs.discovery import ClaudeModelDiscovery
from connector.runtimes.claude.domain.models import (
    ClaudeModelSelection,
    claude_model_catalog,
    model_selection_from_selection_id,
)
from connector.runtimes.claude.domain.permissions import claude_permission_catalog
from connector.runtimes.claude.sdk.client import SdkLoader

CLAUDE_MODEL_CATALOG_STATIC_REVISION = 4
CLAUDE_PERMISSION_CATALOG_STATIC_REVISION = 1


@dataclass(slots=True)
class ClaudeCatalogReader:
    config: RuntimeConfig
    sdk_loader: SdkLoader | None = None
    discovery: ClaudeModelDiscovery = field(init=False)

    def __post_init__(self) -> None:
        self.discovery = ClaudeModelDiscovery(
            config_values=self.config.values,
            sdk_loader=self.sdk_loader,
        )

    async def list_model_catalog(
        self,
        query: str | None = None,
        limit: int = 100,
    ) -> RuntimeModelCatalog:
        cli_models = await self.discovery.models() or ()
        return claude_model_catalog(
            revision=runtime_catalog_revision(
                self.config.revision,
                CLAUDE_MODEL_CATALOG_STATIC_REVISION,
            ),
            query=query,
            limit=limit,
            custom_models=self.config.values.get("customModels"),
            cli_models=cli_models,
        )

    async def resolve_model_selection(
        self,
        selection_id: str | None,
    ) -> ClaudeModelSelection | None:
        """Resolve a selection, reading the CLI list only when it is needed.

        A selection made from the CLI list (for example after a Connector
        restart) is unknown until discovery has run once.
        """

        try:
            return self.model_selection(selection_id)
        except RuntimeInvalidRequestError:
            if self.discovery.attempted:
                raise
        await self.discovery.models()
        return self.model_selection(selection_id)

    def model_selection(self, selection_id: str | None) -> ClaudeModelSelection | None:
        return model_selection_from_selection_id(
            selection_id,
            self.custom_models,
            self.cli_models,
        )

    @property
    def cli_models(self) -> tuple[dict[str, Any], ...]:
        return self.discovery.cached_models

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
