from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import ValidationError
from referencing import Registry, Resource

ROOT = Path(__file__).resolve().parent
SCHEMA_DIR = ROOT / "schemas"
FIXTURE_DIR = ROOT / "fixtures"


def load_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"{path.relative_to(ROOT)} must contain a JSON object")
    return value


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    schema_paths = sorted(SCHEMA_DIR.glob("*.schema.json"))
    if not schema_paths:
        raise RuntimeError("no Runtime Control schemas found")

    schemas = {path.name: load_json(path) for path in schema_paths}
    registry = Registry()
    for path in schema_paths:
        schema = schemas[path.name]
        Draft202012Validator.check_schema(schema)
        schema_id = schema.get("$id")
        if not isinstance(schema_id, str) or not schema_id:
            raise ValueError(f"{path.relative_to(ROOT)} is missing $id")
        registry = registry.with_resource(schema_id, Resource.from_contents(schema))

    manifest = load_json(ROOT / "manifest.json")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list):
        raise TypeError("manifest artifacts must be an array")

    slugs: set[str] = set()
    manifest_paths: set[Path] = set()
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise TypeError("manifest artifact must be an object")
        slug = artifact.get("slug")
        relative_path = artifact.get("path")
        expected_hash = artifact.get("sha256")
        if not all(
            isinstance(value, str) for value in (slug, relative_path, expected_hash)
        ):
            raise TypeError("manifest artifact slug, path, and sha256 must be strings")
        assert isinstance(slug, str)
        assert isinstance(relative_path, str)
        assert isinstance(expected_hash, str)
        if slug in slugs:
            raise ValueError(f"duplicate manifest slug: {slug}")
        slugs.add(slug)
        path = ROOT / relative_path
        if path.parent != SCHEMA_DIR or path.name not in schemas:
            raise ValueError(f"manifest references an unknown schema: {relative_path}")
        manifest_paths.add(path)
        actual_hash = sha256(path)
        if actual_hash != expected_hash:
            raise ValueError(
                f"sha256 mismatch for {relative_path}: {actual_hash} != {expected_hash}"
            )

    if manifest_paths != set(schema_paths):
        missing = sorted(path.name for path in set(schema_paths) - manifest_paths)
        raise ValueError(f"schemas missing from manifest: {missing}")

    format_checker = FormatChecker()
    valid_count = validate_fixtures(
        "valid",
        schemas,
        registry,
        format_checker,
        expect_valid=True,
    )
    invalid_count = validate_fixtures(
        "invalid",
        schemas,
        registry,
        format_checker,
        expect_valid=False,
    )

    fixture_slugs = {
        path.parent.name
        for kind in ("valid", "invalid")
        for path in (FIXTURE_DIR / kind).glob("*/*.json")
    }
    if fixture_slugs != slugs:
        raise ValueError(
            "fixture and manifest slugs differ: "
            f"fixtures={sorted(fixture_slugs)} manifest={sorted(slugs)}"
        )

    print(
        f"validated {len(schema_paths)} schemas, "
        f"{valid_count} valid fixtures, and {invalid_count} invalid fixtures"
    )


def validate_fixtures(
    kind: str,
    schemas: dict[str, dict[str, Any]],
    registry: Registry[Any],
    format_checker: FormatChecker,
    *,
    expect_valid: bool,
) -> int:
    count = 0
    for fixture_path in sorted((FIXTURE_DIR / kind).glob("*/*.json")):
        slug = fixture_path.parent.name
        schema_name = f"{slug}.schema.json"
        schema = schemas.get(schema_name)
        if schema is None:
            raise ValueError(f"{fixture_path.relative_to(ROOT)} has no matching schema")
        validator = Draft202012Validator(
            schema,
            registry=registry,
            format_checker=format_checker,
        )
        payload = load_json(fixture_path)
        if expect_valid:
            validator.validate(payload)
        else:
            try:
                validator.validate(payload)
            except ValidationError:
                pass
            else:
                raise AssertionError(
                    f"invalid fixture was accepted: {fixture_path.relative_to(ROOT)}"
                )
        count += 1
    return count


if __name__ == "__main__":
    main()
