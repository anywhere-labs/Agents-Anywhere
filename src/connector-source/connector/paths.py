from __future__ import annotations

import os
from pathlib import Path

DATA_DIR_ENV = "AGENT_CONNECTOR_DATA_DIR"
DATA_DIR_NAME = ".agents-anywhere"
LEGACY_DATA_DIR_NAME = ".agent-server"
LEGACY_SQLITE_NAMES = {
    "connector-state.sqlite3",
    "connector-state.sqlite3-shm",
    "connector-state.sqlite3-wal",
}


def connector_data_dir() -> Path:
    configured = os.environ.get(DATA_DIR_ENV)
    if configured:
        return Path(configured).expanduser().resolve(strict=False)
    home = Path.home()
    canonical = home / DATA_DIR_NAME
    _merge_legacy_data_dir(home / LEGACY_DATA_DIR_NAME, canonical)
    canonical.mkdir(parents=True, exist_ok=True)
    canonical.chmod(0o700)
    return canonical


def _merge_legacy_data_dir(legacy: Path, canonical: Path) -> None:
    if not legacy.is_dir():
        return
    canonical.mkdir(parents=True, exist_ok=True)
    canonical.chmod(0o700)
    for source in legacy.iterdir():
        if source.name in LEGACY_SQLITE_NAMES:
            source.unlink(missing_ok=True)
            continue
        target = _available_target(canonical / source.name)
        source.replace(target)
    legacy.rmdir()


def _available_target(target: Path) -> Path:
    if not target.exists():
        return target
    index = 1
    while True:
        candidate = target.with_name(f"{target.name}.legacy-{index}")
        if not candidate.exists():
            return candidate
        index += 1
