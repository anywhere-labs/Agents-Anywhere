"""Prepare the shared Pi adapter before Desktop starts its Connector."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from ...infrastructure.npm import install_npm_runtime

# The managed environment keeps a verified SDK; the adapter follows its 0.1.x
# releases because every patch anchor is re-checked before use. Desktop builds
# its bundled copy from the same file.
DEPENDENCIES: dict[str, str] = json.loads(
    Path(__file__).with_name("dependencies.json").read_text(encoding="utf-8")
)
BUNDLED_RUNTIME_ENV = "AA_PI_BUNDLED_RUNTIME"


def npm_root(fallback: Path) -> Path:
    configured = os.environ.get("AA_PI_NPM_ROOT")
    return Path(configured) if configured else fallback


def bundled_runtime() -> Path | None:
    """Desktop ships the dependencies pre-installed; seeding needs no network."""
    configured = os.environ.get(BUNDLED_RUNTIME_ENV)
    return Path(configured) if configured else None


def prepare_environment(root: Path) -> None:
    print("Checking Pi ACP adapter and dependencies", flush=True)
    install_npm_runtime(
        root, DEPENDENCIES, "@openma/pi-acp/dist/bin.js",
        output=sys.stdout,
        on_install=lambda: print("Preparing Pi ACP adapter and dependencies", flush=True),
        bundle=bundled_runtime(),
    )
    print("Pi ACP adapter and dependencies ready", flush=True)
