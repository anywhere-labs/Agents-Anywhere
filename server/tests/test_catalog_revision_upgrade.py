"""Catalogs stored before a protocol field existed stay valid at the same revision.

2.1.0 added an optional ``group`` to model catalog items. Rows written by
2.0.3 lack it, while a 2.1.0 Server serializes it as ``null`` (or, for DSH, as
a group the Connector derives from provider metadata) without the runtime
bumping its revision.
"""

from __future__ import annotations

import asyncio
import copy
from typing import Any

import pytest
from sqlalchemy import insert

from agent_server.core.catalogs import compare_same_revision_catalogs
from agent_server.infra.db import connectors
from agent_server.infra.repositories.facade import Store
from agent_server.services.connector_notifications import (
    NotificationValidationError,
    RuntimeCatalogNotificationHandler,
)

CONNECTOR_ID = "conn_catalog_upgrade"


def test_same_revision_catalog_without_group_is_idempotent() -> None:
    store = Store()
    try:
        asyncio.run(_insert_connector(store))
        stored = _legacy_codex_catalog()
        _seed(store, runtime="codex", catalog=stored)

        effect = _report(store, _with_null_groups(stored))

        assert effect is not None
        assert effect.catalogs is None
        assert _stored(store, runtime="codex") == stored
    finally:
        asyncio.run(store.close())


def test_same_revision_catalog_adding_groups_replaces_stored_copy() -> None:
    store = Store()
    try:
        asyncio.run(_insert_connector(store))
        stored = _legacy_dsh_catalog()
        _seed(store, runtime="dsh", catalog=stored)
        reported = _with_dsh_groups(stored)

        effect = _report(store, reported)

        assert effect is not None
        assert effect.catalogs is not None
        assert effect.catalogs["model"]["models"][0]["group"]["id"] == "relay-a"
        assert _stored(store, runtime="dsh") == effect.catalogs["model"]
        # The upgraded copy is now the baseline for the same revision.
        assert _report(store, reported).catalogs is None
    finally:
        asyncio.run(store.close())


def test_same_revision_content_change_is_still_a_conflict() -> None:
    store = Store()
    try:
        asyncio.run(_insert_connector(store))
        stored = _legacy_dsh_catalog()
        _seed(store, runtime="dsh", catalog=stored)
        changed = _with_dsh_groups(stored)
        changed["models"][0]["displayName"] = "Renamed"

        with pytest.raises(NotificationValidationError) as raised:
            _report(store, changed)

        assert raised.value.code == "catalog_revision_conflict"
        assert _stored(store, runtime="dsh") == stored
    finally:
        asyncio.run(store.close())


def test_compare_treats_missing_defaults_as_equal_for_permissions() -> None:
    stored = {
        "runtime": "codex",
        "revision": 2,
        "permissions": [{"id": "default", "displayName": "Default", "selectionId": "sel_p"}],
    }
    reported = copy.deepcopy(stored)
    reported["permissions"][0].update({"description": None, "default": False, "metadata": {}})

    assert compare_same_revision_catalogs("permission", stored, reported) == "idempotent"


def test_compare_rejects_groups_with_changed_metadata() -> None:
    stored = _legacy_dsh_catalog()
    reported = _with_dsh_groups(stored)
    reported["models"][1]["metadata"]["providerName"] = "Relay C"

    assert compare_same_revision_catalogs("model", stored, reported) == "conflict"


def _legacy_codex_catalog() -> dict[str, Any]:
    # Exactly what a 2.0.3 Server wrote: every item field except ``group``.
    return {
        "runtime": "codex",
        "revision": 4002,
        "models": [
            {
                "displayName": "GPT 5.5",
                "id": "gpt-5.5",
                "selectionId": None,
                "description": None,
                "default": True,
                "reasoningItems": [
                    {
                        "displayName": "High",
                        "id": "high",
                        "fullModelId": "gpt-5.5",
                        "selectionId": "sel_gpt_high",
                        "description": None,
                        "default": True,
                        "metadata": {},
                    }
                ],
                "metadata": {"enabled": True},
            }
        ],
    }


def _legacy_dsh_catalog() -> dict[str, Any]:
    def item(model: str, provider: str, provider_name: str) -> dict[str, Any]:
        return {
            "displayName": f"{model} ({provider_name})",
            "id": f"{provider}/{model}",
            "selectionId": f"sel_{provider}_{model}",
            "description": None,
            "default": False,
            "reasoningItems": [],
            "metadata": {
                "provider": provider,
                "providerName": provider_name,
                "model": model,
                "modelName": model,
                "enabled": True,
            },
        }

    return {
        "runtime": "dsh",
        "revision": 17,
        "models": [
            item("deepseek-v4", "relay-a", "Relay A"),
            item("deepseek-v4", "relay-b", "Relay B"),
        ],
    }


def _with_null_groups(catalog: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(catalog)
    for model in result["models"]:
        model["group"] = None
    return result


def _with_dsh_groups(catalog: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(catalog)
    for model in result["models"]:
        metadata = model["metadata"]
        model["group"] = {
            "id": metadata["provider"],
            "displayName": metadata["providerName"],
            "itemDisplayName": metadata["modelName"],
        }
    return result


def _seed(store: Store, *, runtime: str, catalog: dict[str, Any]) -> None:
    outcome = asyncio.run(
        store.update_protocol_catalog(
            CONNECTOR_ID,
            runtime=runtime,
            catalog_type="model",
            revision=catalog["revision"],
            catalog=catalog,
        )
    )
    assert outcome == "accepted"


def _report(store: Store, catalog: dict[str, Any]) -> Any:
    handler = RuntimeCatalogNotificationHandler(store)  # type: ignore[arg-type]
    return asyncio.run(
        handler.apply(
            connector_id=CONNECTOR_ID,
            method="runtime.catalog.updated",
            params={"catalogType": "model", "catalog": catalog},
        )
    )


def _stored(store: Store, *, runtime: str) -> dict[str, Any] | None:
    return asyncio.run(
        store.get_protocol_catalog(
            CONNECTOR_ID,
            runtime_id=runtime,
            catalog_type="model",
        )
    )


async def _insert_connector(store: Store) -> None:
    now = "2026-10-27T00:00:00Z"
    await store.create_user(user_id="user_catalog_upgrade", password="test-password")
    async with store.engine.begin() as connection:
        await connection.execute(
            insert(connectors).values(
                id=CONNECTOR_ID,
                user_id="user_catalog_upgrade",
                name=CONNECTOR_ID,
                status="offline",
                token_hash=f"hash_{CONNECTOR_ID}",
                token_prefix=f"prefix_{CONNECTOR_ID}",
                revoked=0,
                created_at=now,
                updated_at=now,
            )
        )
