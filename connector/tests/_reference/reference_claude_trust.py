from __future__ import annotations

import json
from pathlib import Path

from connector.claude.trust import ensure_trust


def test_creates_config_file_when_missing(tmp_path: Path) -> None:
    cfg = tmp_path / ".claude.json"
    ensure_trust("/work/foo", config_path=cfg)
    data = json.loads(cfg.read_text())
    assert data["projects"]["/work/foo"]["hasTrustDialogAccepted"] is True


def test_idempotent_no_second_write(tmp_path: Path) -> None:
    cfg = tmp_path / ".claude.json"
    ensure_trust("/work/foo", config_path=cfg)
    mtime_first = cfg.stat().st_mtime_ns

    # Second call must be a no-op (no rewrite).
    import time
    time.sleep(0.01)
    ensure_trust("/work/foo", config_path=cfg)
    assert cfg.stat().st_mtime_ns == mtime_first


def test_preserves_existing_fields(tmp_path: Path) -> None:
    cfg = tmp_path / ".claude.json"
    cfg.write_text(json.dumps({
        "projects": {"/work/foo": {"someOtherKey": 1}},
        "topLevelField": "leave-me",
    }))
    ensure_trust("/work/foo", config_path=cfg)
    data = json.loads(cfg.read_text())
    assert data["projects"]["/work/foo"]["someOtherKey"] == 1
    assert data["projects"]["/work/foo"]["hasTrustDialogAccepted"] is True
    assert data["topLevelField"] == "leave-me"


def test_writes_both_raw_and_resolved_when_different(tmp_path: Path) -> None:
    cfg = tmp_path / ".claude.json"
    # Use a real symlink so cwd vs resolved differ.
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "linked"
    link.symlink_to(real)
    ensure_trust(str(link), config_path=cfg)
    data = json.loads(cfg.read_text())
    projects = data["projects"]
    assert projects[str(link)]["hasTrustDialogAccepted"] is True
    assert projects[str(real)]["hasTrustDialogAccepted"] is True


def test_malformed_existing_config_is_replaced(tmp_path: Path) -> None:
    cfg = tmp_path / ".claude.json"
    cfg.write_text("{ not json")
    ensure_trust("/work/foo", config_path=cfg)
    data = json.loads(cfg.read_text())
    assert data["projects"]["/work/foo"]["hasTrustDialogAccepted"] is True
