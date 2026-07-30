from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from agent_server.core.protocol import (
    ProtocolCapabilitySet,
    ProtocolEventEnvelope,
    ProtocolModelCatalog,
    ProtocolPermissionCatalog,
)

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_DIR = REPOSITORY_ROOT / "contracts" / "protocol" / "1.0"
SCHEMA_DIR = CONTRACT_DIR / "schemas"

FIXTURE_MODELS = {
    "capability-set": ProtocolCapabilitySet,
    "event-envelope": ProtocolEventEnvelope,
    "model-catalog": ProtocolModelCatalog,
    "permission-catalog": ProtocolPermissionCatalog,
}


def _load_json(path: Path) -> dict:
    return json.loads(path.read_text())


def _fixture_paths(kind: str) -> list[Path]:
    return sorted((CONTRACT_DIR / "fixtures" / kind).glob("*/*.json"))


def test_protocol_contract_artifacts_are_fresh(tmp_path: Path) -> None:
    generated_dir = tmp_path / "1.0"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "scripts.export_protocol_schemas",
            "--output",
            str(generated_dir),
        ],
        cwd=REPOSITORY_ROOT / "server",
        check=True,
    )

    expected_files = sorted(
        path.relative_to(CONTRACT_DIR)
        for path in CONTRACT_DIR.glob("schemas/*.schema.json")
    )
    generated_files = sorted(
        path.relative_to(generated_dir)
        for path in generated_dir.glob("schemas/*.schema.json")
    )
    assert generated_files == expected_files
    for relative_path in [Path("manifest.json"), *expected_files]:
        assert (generated_dir / relative_path).read_bytes() == (
            CONTRACT_DIR / relative_path
        ).read_bytes()


@pytest.mark.parametrize(
    "schema_path",
    sorted(SCHEMA_DIR.glob("*.schema.json")),
    ids=lambda path: path.stem.removesuffix(".schema"),
)
def test_protocol_contract_schema_is_valid(schema_path: Path) -> None:
    Draft202012Validator.check_schema(_load_json(schema_path))


@pytest.mark.parametrize(
    "fixture_path",
    _fixture_paths("valid"),
    ids=lambda path: f"{path.parent.name}/{path.stem}",
)
def test_valid_protocol_fixtures_match_schema_and_server_model(
    fixture_path: Path,
) -> None:
    slug = fixture_path.parent.name
    payload = _load_json(fixture_path)
    Draft202012Validator(
        _load_json(SCHEMA_DIR / f"{slug}.schema.json")
    ).validate(payload)

    model = FIXTURE_MODELS[slug].model_validate(payload)
    assert model.model_dump(mode="json") == payload


@pytest.mark.parametrize(
    "fixture_path",
    _fixture_paths("invalid"),
    ids=lambda path: f"{path.parent.name}/{path.stem}",
)
def test_invalid_protocol_fixtures_are_rejected(fixture_path: Path) -> None:
    slug = fixture_path.parent.name
    validator = Draft202012Validator(
        _load_json(SCHEMA_DIR / f"{slug}.schema.json")
    )
    assert not validator.is_valid(_load_json(fixture_path))
