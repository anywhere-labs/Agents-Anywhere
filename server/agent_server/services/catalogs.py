from __future__ import annotations

from pydantic import ValidationError

from agent_server.core.catalogs import (
    CatalogDomainError,
    CatalogType,
    CatalogUpdateOutcome,
    validate_model_catalog,
    validate_permission_catalog,
)
from agent_server.core.models import RuntimeName
from agent_server.core.protocol import (
    ProtocolModelCatalog,
    ProtocolPermissionCatalog,
)
from agent_server.services.model_catalog import resolve_model_selection
from agent_server.services.permission_catalog import resolve_permission_selection
from agent_server.services.repository_ports import CatalogRepository


class CatalogServiceError(ValueError):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


class CatalogService:
    def __init__(self, store: CatalogRepository) -> None:
        self._store = store

    async def ingest(
        self,
        connector_id: str,
        *,
        catalog_type: CatalogType,
        payload: dict[str, object],
    ) -> CatalogUpdateOutcome:
        catalog = self._parse(catalog_type, payload)
        outcome = await self._store.update_protocol_catalog(
            connector_id,
            runtime=catalog.runtime,
            catalog_type=catalog_type,
            revision=catalog.revision,
            catalog=catalog.model_dump(mode="json"),
        )
        if outcome == "conflict":
            raise CatalogServiceError(
                "catalog_revision_conflict",
                "catalog content changed without a revision increase",
            )
        return outcome

    async def model_catalog(
        self,
        connector_id: str,
        *,
        runtime: RuntimeName,
        user_id: str | None = None,
    ) -> ProtocolModelCatalog | None:
        raw = await self._store.get_protocol_catalog(
            connector_id,
            runtime=runtime,
            catalog_type="model",
            user_id=user_id,
        )
        if raw is None:
            return None
        catalog = self._parse("model", raw)
        if catalog.runtime != runtime:
            raise CatalogServiceError("invalid_catalog", "catalog runtime mismatch")
        return catalog

    async def permission_catalog(
        self,
        connector_id: str,
        *,
        runtime: RuntimeName,
        user_id: str | None = None,
    ) -> ProtocolPermissionCatalog | None:
        raw = await self._store.get_protocol_catalog(
            connector_id,
            runtime=runtime,
            catalog_type="permission",
            user_id=user_id,
        )
        if raw is None:
            return None
        catalog = self._parse("permission", raw)
        if catalog.runtime != runtime:
            raise CatalogServiceError("invalid_catalog", "catalog runtime mismatch")
        return catalog

    async def resolve_model(
        self,
        connector_id: str,
        *,
        runtime: RuntimeName,
        selection_id: str,
    ) -> tuple[str, str | None]:
        catalog = await self.model_catalog(connector_id, runtime=runtime)
        if catalog is None:
            raise CatalogServiceError("catalog_unavailable", "model catalog is unavailable")
        try:
            return resolve_model_selection(catalog, selection_id)
        except KeyError:
            raise CatalogServiceError(
                "invalid_selection",
                "invalid modelSelectionId",
            ) from None

    async def resolve_permission(
        self,
        connector_id: str,
        *,
        runtime: RuntimeName,
        selection_id: str,
    ) -> dict[str, object]:
        catalog = await self.permission_catalog(connector_id, runtime=runtime)
        if catalog is None:
            raise CatalogServiceError(
                "catalog_unavailable",
                "permission catalog is unavailable",
            )
        try:
            return resolve_permission_selection(catalog, selection_id)
        except KeyError:
            raise CatalogServiceError(
                "invalid_selection",
                "invalid permissionSelectionId",
            ) from None

    @staticmethod
    def _parse(
        catalog_type: CatalogType,
        payload: dict[str, object],
    ) -> ProtocolModelCatalog | ProtocolPermissionCatalog:
        model = ProtocolModelCatalog if catalog_type == "model" else ProtocolPermissionCatalog
        try:
            catalog = model.model_validate(payload)
            if isinstance(catalog, ProtocolModelCatalog):
                validate_model_catalog(catalog)
            else:
                validate_permission_catalog(catalog)
            return catalog
        except (CatalogDomainError, ValidationError) as exc:
            raise CatalogServiceError("invalid_catalog", str(exc)) from exc
