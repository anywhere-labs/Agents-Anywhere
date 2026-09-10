from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from connector.server.catalogs import (
    model_catalog_from_runtime_items,
    permission_catalog_from_items,
)
from connector.server.protocol import (
    ProtocolCapabilitySet,
    ProtocolModelCatalog,
    ProtocolPermissionCatalog,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_DIR = REPOSITORY_ROOT / "contracts" / "protocol" / "1.0"
SCHEMA_DIR = CONTRACT_DIR / "schemas"

FIXTURE_MODELS = {
    "capability-set": ProtocolCapabilitySet,
    "model-catalog": ProtocolModelCatalog,
    "permission-catalog": ProtocolPermissionCatalog,
}


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def _validate(slug: str, payload: dict) -> None:
    Draft202012Validator(_load_json(SCHEMA_DIR / f"{slug}.schema.json")).validate(payload)


@pytest.mark.parametrize(
    "fixture_path",
    sorted(path for slug in FIXTURE_MODELS for path in (CONTRACT_DIR / "fixtures" / "valid" / slug).glob("*.json")),
    ids=lambda path: f"{path.parent.name}/{path.stem}",
)
def test_connector_models_round_trip_canonical_fixtures(
    fixture_path: Path,
) -> None:
    slug = fixture_path.parent.name
    payload = _load_json(fixture_path)

    model = FIXTURE_MODELS[slug].model_validate(payload)
    dumped = model.model_dump(mode="json")

    assert dumped == payload
    _validate(slug, dumped)


def test_connector_model_catalog_builder_matches_contract() -> None:
    catalog = model_catalog_from_runtime_items(
        "codex",
        revision=12,
        items=[
            {
                "id": "gpt-example",
                "displayName": "GPT Example",
                "reasoningEfforts": ["low", "high"],
                "defaultReasoningEffort": "high",
                "vendorExtension": {"channel": "preview"},
            }
        ],
    )

    payload = catalog.model_dump(mode="json")
    _validate("model-catalog", payload)
    assert payload["models"][0]["metadata"]["raw"]["vendorExtension"] == {"channel": "preview"}


def test_connector_permission_catalog_builder_matches_contract() -> None:
    catalog = permission_catalog_from_items(
        "codex",
        revision=13,
        items=[
            {
                "id": "fullAccess",
                "label": "Full access",
                "default": True,
                "identity": {"permission_mode": "fullAccess"},
                "runtimeSettings": {"approvalPolicy": "never"},
            }
        ],
    )

    payload = catalog.model_dump(mode="json")
    _validate("permission-catalog", payload)
    assert payload["permissions"][0]["metadata"]["runtimeSettings"] == {"approvalPolicy": "never"}


def test_catalog_builders_normalize_defaults_to_one_item() -> None:
    models = model_catalog_from_runtime_items(
        "codex",
        revision=20,
        items=[
            {"id": "first", "default": True, "reasoningEfforts": ["low", "high"]},
            {"id": "second", "default": True},
        ],
    )
    permissions = permission_catalog_from_items(
        "codex",
        revision=21,
        items=[
            {"id": "first", "label": "First"},
            {"id": "second", "label": "Second"},
        ],
    )

    assert [item.default for item in models.models] == [True, False]
    assert [item.default for item in models.models[0].reasoningItems] == [True, False]
    assert [item.default for item in permissions.permissions] == [True, False]
