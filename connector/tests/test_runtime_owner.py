from __future__ import annotations

import json
import os

import pytest

from connector.core import runtime_owner
from connector.core.config import ConnectorConfig
from connector.core.runtime_owner import (
    ConnectorAlreadyRunningError, RuntimeLease, read_runtime, read_state, runtime_path, state_transaction,
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
    with pytest.raises(ConnectorAlreadyRunningError):
        RuntimeLease().claim()


def test_child_attaches_only_to_matching_host_and_detaches_without_releasing_it(monkeypatch):
    host = RuntimeLease(kind="desktop-workbench")
    host.claim()
    monkeypatch.setenv("AA_CONNECTOR_OWNER_INSTANCE", host.instance_id)
    monkeypatch.setenv("AA_CONNECTOR_OWNER_PID", str(os.getpid()))
    child = RuntimeLease(delegated=True)
    child.claim(config())
    assert read_state(host.path)["runtime"]["childPid"] == os.getpid()
    host.release()
    assert read_runtime(host.path) is not None
    child.release()
    assert "childPid" not in read_state(host.path)["runtime"]
    assert read_runtime(host.path).kind == "desktop-workbench"
    host.release()
    with pytest.raises(RuntimeError, match="host no longer owns"):
        child.claim()


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
