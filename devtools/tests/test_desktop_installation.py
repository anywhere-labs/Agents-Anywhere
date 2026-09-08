from __future__ import annotations

import json
import stat
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from pathlib import Path

import pytest

from devtools import control


@pytest.fixture
def runtime_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(control._connector_runtime(), "system_home", lambda: tmp_path)
    return tmp_path / ".agents-anywhere" / "connector-runtime.json"


@pytest.mark.parametrize("kind", ["cli", "desktop-workbench", "dsh-plugin"])
def test_clear_only_desktop_installation(runtime_file: Path, kind: str) -> None:
    state = {
        "version": 2,
        "legacyMachineMigrated": True,
        "desktop": {"platform": "darwin", "executablePath": "/test/Desktop"},
        "connectorIds": ["conn_first", "conn_second"],
        "runtime": {
            "kind": kind, "pid": 42, "childPid": 43, "instanceId": "test-owner",
            "startedAt": "2026-09-07", "processStartedAt": "parent-start",
            "childStartedAt": "child-start", "connectorId": "conn_first",
        },
        "futureMetadata": {"keep": True},
    }
    runtime_file.parent.mkdir()
    runtime_file.write_text(json.dumps(state))

    control.clear_desktop_installation()

    expected = {key: value for key, value in state.items() if key != "desktop"}
    assert json.loads(runtime_file.read_text()) == expected
    assert stat.S_IMODE(runtime_file.stat().st_mode) == 0o600
    control.clear_desktop_installation()
    assert json.loads(runtime_file.read_text()) == expected


def test_clear_migrates_legacy_records_without_losing_ids_or_pid(runtime_file: Path) -> None:
    legacy = runtime_file.parent.parent / ".agentsanywhere" / "machine.json"
    legacy.parent.mkdir()
    legacy.write_text(json.dumps({
        "version": 1, "connectorIds": ["conn_old"], "desktop": {"appPath": "/old"},
    }))
    installation = legacy.parent / "desktop" / "install.json"
    installation.parent.mkdir()
    installation.write_text(json.dumps({"version": 1, "appPath": "/old"}))
    runtime_file.parent.mkdir()
    runtime_file.write_text(json.dumps({
        "pid": 42, "kind": "cli", "connectorId": "conn_current", "startedAt": "before-migration",
    }))

    control.clear_desktop_installation()

    state = json.loads(runtime_file.read_text())
    assert state["version"] == 2
    assert state["legacyMachineMigrated"] is True
    assert state["connectorIds"] == ["conn_old", "conn_current"]
    assert state["runtime"]["pid"] == 42
    assert state["runtime"]["connectorId"] == "conn_current"
    assert "desktop" not in state
    assert not legacy.exists()
    assert not installation.exists()


def test_clear_before_first_launch_prevents_legacy_installation_reappearing(runtime_file: Path) -> None:
    control.clear_desktop_installation()

    assert json.loads(runtime_file.read_text()) == {
        "version": 2, "connectorIds": [], "legacyMachineMigrated": True,
    }
    installation = runtime_file.parent.parent / ".agentsanywhere" / "desktop" / "install.json"
    installation.parent.mkdir(parents=True)
    installation.write_text(json.dumps({"version": 1, "appPath": "/old"}))
    with control._connector_runtime().state_transaction(runtime_file) as state:
        assert "desktop" not in state


@pytest.mark.parametrize("contents", [
    "{broken", "[]", '{"version": 3}',
    '{"version": 2, "runtime": {"pid": 0}}',
])
def test_invalid_shared_record_is_not_overwritten(runtime_file: Path, contents: str) -> None:
    runtime_file.parent.mkdir()
    runtime_file.write_text(contents)

    with pytest.raises(control.DevControlError, match="清除 Desktop 安装记录失败"):
        control.clear_desktop_installation()

    assert runtime_file.read_text() == contents


def test_clear_serializes_with_connector_updates(runtime_file: Path) -> None:
    runtime = control._connector_runtime()
    with ThreadPoolExecutor(max_workers=1) as executor:
        with runtime.state_transaction(runtime_file) as state:
            state["desktop"] = {"appPath": "/test/Desktop"}
            clearing = executor.submit(control.clear_desktop_installation)
            with pytest.raises(TimeoutError):
                clearing.result(timeout=0.1)
            state["connectorIds"].append("conn_concurrent")
        clearing.result(timeout=2)

    state = json.loads(runtime_file.read_text())
    assert state["connectorIds"] == ["conn_concurrent"]
    assert "desktop" not in state
