from __future__ import annotations

import importlib.metadata
from typing import Any


def check_codex_sdk() -> dict[str, Any]:
    try:
        version = importlib.metadata.version("openai-codex")
    except importlib.metadata.PackageNotFoundError:
        return {
            "available": False,
            "package": "openai-codex",
            "reason": "package not installed",
        }
    return {
        "available": True,
        "package": "openai-codex",
        "version": version,
    }
