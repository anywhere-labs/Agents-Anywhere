from __future__ import annotations

import json
import stat
from pathlib import Path

from loadtests.connector_ws.generate_data import (
    atomic_write_private,
    latest_setup_token,
    session_meta_notification,
)


def test_latest_setup_token_uses_last_banner(tmp_path: Path) -> None:
    log = tmp_path / "server.log"
    log.write_text(
        "setup-token: expired\nother output\nsetup-token: current-token\n",
        encoding="utf-8",
    )

    assert latest_setup_token(log) == "current-token"


def test_atomic_manifest_is_private_and_valid(tmp_path: Path) -> None:
    path = tmp_path / "nested" / "data.json"
    document = {"token": "secret", "connectors": []}

    atomic_write_private(path, document)

    assert json.loads(path.read_text(encoding="utf-8")) == document
    assert stat.S_IMODE(path.stat().st_mode) == 0o600


def test_session_fixture_matches_connector_identity() -> None:
    notification = session_meta_notification(
        connector_index=2,
        session_index=17,
        prefix="load",
    )

    assert notification["method"] == "session.meta.upsert"
    params = notification["params"]
    assert params["sessionId"] == "load-c002-s00017"
    assert params["externalSessionId"] == "thr-load-c002-s00017"
    assert params["runtime"] == "codex"
    assert params["runtimeId"] == "codex"
    assert params["cwd"] == "/loadtest/load/connector-002"
    assert params["sourceState"]["observationOrigin"] == "inventory"
