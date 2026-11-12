"""Generate additive ACP and workflow 1.2 contracts without changing 1.1."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def write(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    )


def main():
    schema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "urn:agents-anywhere:acp-runtime:1.0",
        "$defs": {
            "configuration": {
                "type": "object",
                "required": ["revision", "options"],
                "properties": {
                    "revision": {"type": "integer", "minimum": 0},
                    "options": {
                        "type": "array",
                        "maxItems": 128,
                        "items": {
                            "type": "object",
                            "required": ["type", "name", "currentValue"],
                            "properties": {
                                "configId": {"type": "string"},
                                "id": {"type": "string"},
                                "name": {"type": "string"},
                                "type": {"enum": ["select", "boolean"]},
                                "currentValue": {"type": ["string", "boolean"]},
                                "options": {"type": "array"},
                            },
                            "anyOf": [{"required": ["configId"]}, {"required": ["id"]}],
                        },
                    },
                },
            },
            "formResponse": {
                "type": "object",
                "additionalProperties": False,
                "required": ["kind", "values"],
                "properties": {"kind": {"const": "form"}, "values": {"type": "object"}},
            },
            "sourceReplacement": {
                "type": "object",
                "additionalProperties": False,
                "required": ["sessionId", "sourceId", "epoch", "complete", "items"],
                "properties": {
                    "sessionId": {"type": "string"},
                    "sourceId": {"type": "string"},
                    "epoch": {"type": "string"},
                    "complete": {"const": True},
                    "items": {"type": "array"},
                },
            },
        },
    }
    write(ROOT / "contracts/acp-runtime/1.0/schema.json", schema)
    for directory in (ROOT / "contracts/acp-runtime/1.0",):
        files = sorted(
            path for path in directory.rglob("*.json") if path.name != "manifest.json"
        )
        write(
            directory / "manifest.json",
            {
                "artifacts": [
                    {
                        "path": str(path.relative_to(directory)),
                        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    }
                    for path in files
                ]
            },
        )


if __name__ == "__main__":
    main()
