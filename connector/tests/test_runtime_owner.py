from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

from connector.core import runtime_owner
from connector.core.config import ConnectorConfig
from connector.core.runtime_owner import (
    ConnectorAlreadyRunningError,
    RuntimeLease,
    read_runtime,
    read_state,
    runtime_path,
    state_transaction,
)


def config(id="conn_1"):
    return ConnectorConfig(server_url="https://api.example.test", connector_id=id, connector_token="PRIVATE")


def test_path_is_independent_of_config_and_data_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_CONNECTOR_DATA_DIR", str(tmp_path / "custom-data"))
    assert runtime_path(tmp_path / "custom.json") == runtime_path()
    assert runtime_path() == runtime_owner.system_home() / ".agents-anywhere/connector-runtime.json"


def test_claim_blocks_other_instances_and_stop_keeps_metadata():
    first, second = RuntimeLease(kind="cli"), RuntimeLease(kind="desktop-workbench")
    first.claim(config())
    with pytest.raises(ConnectorAlreadyRunningError):
        second.claim(config("conn_2"))
    second.release()
    assert read_runtime(first.path).kind == "cli"
    first.release()
    assert read_runtime(first.path) is None
    assert read_state(first.path)["connectorIds"] == ["conn_1"]
    assert "PRIVATE" not in first.path.read_text()
    second.claim(config("conn_2"))
    first.release()
    assert read_runtime(first.path).kind == "desktop-workbench"
    second.release()
    assert read_state(first.path)["connectorIds"] == ["conn_1", "conn_2"]


def test_stale_owner_and_reused_pid_can_be_replaced():
    first = RuntimeLease()
    first.claim()
    with state_transaction(first.path) as state:
        state["runtime"]["processStartedAt"] = "different-process-start"
    second = RuntimeLease()
    second.claim()
    with state_transaction(first.path) as state:
        state["runtime"]["pid"] = 99999999
    third = RuntimeLease()
    third.claim()
    third.release()


def test_live_child_blocks_takeover_when_parent_died():
    first = RuntimeLease()
    first.claim()
    with state_transaction(first.path) as state:
        state["runtime"].update(pid=99999999, childPid=os.getpid())
    with pytest.raises(ConnectorAlreadyRunningError) as conflict:
        RuntimeLease().claim()
    assert conflict.value.owner.pid == os.getpid()


def test_host_delegation_environment_cannot_bypass_python_ownership(monkeypatch):
    first = RuntimeLease(kind="cli")
    first.claim(config())
    monkeypatch.setenv("AA_CONNECTOR_OWNER_INSTANCE", first.instance_id)
    monkeypatch.setenv("AA_CONNECTOR_OWNER_PID", str(os.getpid()))
    second = RuntimeLease(kind="desktop-workbench")
    with pytest.raises(ConnectorAlreadyRunningError):
        second.claim(config("conn_2"))
    assert "childPid" not in read_state(first.path)["runtime"]
    assert read_state(first.path)["connectorIds"] == ["conn_1"]
    first.release()
    second.claim(config("conn_2"))
    second.release()


def test_migrates_identity_and_installation_then_preserves_them_on_release():
    home = runtime_owner.system_home()
    legacy = home / ".agentsanywhere/machine.json"
    legacy.parent.mkdir(parents=True)
    legacy.write_text(json.dumps({"version": 1, "connectorIds": ["old"], "desktop": {"appPath": "/app"}, "future": True}))
    lease = RuntimeLease()
    lease.claim(config())
    lease.release()
    state = read_state(lease.path)
    assert state["desktop"] == {"appPath": "/app"}
    assert state["connectorIds"] == ["old", "conn_1"]
    assert state["future"] is True
    assert not legacy.exists()


def test_flat_legacy_runtime_preserves_live_owner():
    path = runtime_path()
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"pid": os.getpid(), "kind": "cli", "connectorId": "old", "serverUrl": "https://example.test"}))
    with pytest.raises(ConnectorAlreadyRunningError):
        RuntimeLease().claim()
    assert read_runtime(path).connector_id == "old"


@pytest.mark.parametrize("value", ["{broken", "[]", '{"version":3}', '{"version":2,"runtime":{"pid":1}}'])
def test_corrupt_or_newer_records_fail_closed(value):
    path = runtime_path()
    path.parent.mkdir(parents=True)
    path.write_text(value)
    with pytest.raises(RuntimeError):
        RuntimeLease().claim()
    assert path.read_text() == value


@pytest.mark.parametrize(("executable", "arguments", "expected"), [
    ("/venv/bin/python3.12", ["python", "/venv/bin/anywhere-cli", "rpc"], True),
    ("/usr/bin/python3", ["python", "-u", "-m", "connector.cli", "start"], True),
    ("C:\\Python\\python.exe", ["python", "C:\\venv\\Scripts\\agent-connector.exe", "rpc"], True),
    ("/bin/electron", ["electron", "anywhere-cli", "rpc"], False),
    ("/bin/uv", ["uv", "run", "anywhere-cli", "rpc"], False),
    ("/bin/python", ["python", "other.py", "anywhere-cli"], False),
    ("/bin/python", ["python", "-c", "print('anywhere-cli')"], False),
])
def test_process_check_recognizes_connector_entry_points_only(executable, arguments, expected):
    assert runtime_owner._connector_command(executable, arguments) is expected


def test_live_unrelated_process_does_not_block_connector_start():
    unrelated = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        lease = RuntimeLease()
        with state_transaction(lease.path) as state:
            state["runtime"] = {
                "instanceId": "stale-record", "pid": unrelated.pid, "kind": "dsh-plugin",
                "startedAt": "old", "processStartedAt": runtime_owner.process_identity(unrelated.pid),
            }
        lease.claim(config())
        assert read_runtime(lease.path).pid == os.getpid()
        assert unrelated.poll() is None, "Checking ownership must not terminate another process"
        lease.release()
    finally:
        unrelated.terminate()
        unrelated.wait(timeout=5)
