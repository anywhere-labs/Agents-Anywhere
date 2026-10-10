from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

OAR_CONFIG_SCHEMA_REVISION = 1


def config_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "additionalProperties": False,
        "properties": {
            "nodeExecutable": {"type": "string", "minLength": 1},
            "sidecarPath": {"type": "string", "minLength": 1},
            "defaultModel": {"type": "string", "minLength": 1},
        },
    }


def defaults() -> dict[str, Any]:
    return {
        "nodeExecutable": shutil.which("node") or "node",
        "sidecarPath": str(Path(__file__).resolve().parents[3] / "oar-sidecar"),
    }


def normalized(values: dict[str, Any]) -> dict[str, Any]:
    result = defaults()
    result.update({key: value for key, value in values.items() if value not in (None, "")})
    return result


def sidecar_path(values: dict[str, Any]) -> str:
    return str(values.get("sidecarPath") or "")


def jsonable(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)
