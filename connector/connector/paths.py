from __future__ import annotations

import os
from pathlib import Path

DATA_DIR_ENV = "AGENT_CONNECTOR_DATA_DIR"
DATA_DIR_NAME = ".agents-anywhere"


def connector_data_dir() -> Path:
    configured = os.environ.get(DATA_DIR_ENV)
    if configured:
        return Path(configured).expanduser().resolve(strict=False)
    canonical = Path.home() / DATA_DIR_NAME
    canonical.mkdir(parents=True, exist_ok=True)
    canonical.chmod(0o700)
    return canonical
