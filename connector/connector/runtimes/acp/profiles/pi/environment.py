"""Prepare the shared Pi adapter before Desktop starts its Connector."""
from __future__ import annotations

import os
import sys
from pathlib import Path

from ...infrastructure.npm import install_npm_runtime

# The managed environment keeps a verified SDK; the adapter follows its 0.1.x
# releases because every patch anchor is re-checked before use.
DEPENDENCIES = {
    "@openma/pi-acp": "^0.1.8",
    "@earendil-works/pi-coding-agent": "1.4.0",
    "@earendil-works/pi-ai": "1.4.0",
    "@earendil-works/pi-agent-core": "1.4.0",
}


def npm_root(fallback: Path) -> Path:
    configured = os.environ.get("AA_PI_NPM_ROOT")
    return Path(configured) if configured else fallback


def prepare_environment(root: Path) -> None:
    print("Preparing Pi ACP adapter and dependencies", flush=True)
    install_npm_runtime(
        root, DEPENDENCIES, "@openma/pi-acp/dist/bin.js",
        output=sys.stdout,
    )
    print("Pi ACP adapter and dependencies ready", flush=True)
