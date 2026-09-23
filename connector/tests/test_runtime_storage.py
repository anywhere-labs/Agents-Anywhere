import asyncio
import os
from unittest.mock import AsyncMock

import pytest

from connector.core.json_kv import JsonKeyValueStore
from connector.runtime_protocol import RuntimeInstanceHost, RuntimeInstanceSpec, RuntimeSourceKey
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.runtime_storage import RuntimeStorageManager
from connector.server.sync_state import JsonSyncStateStore


@pytest.mark.parametrize("copy_legacy", [False, True])
def test_prepare_fsync_requires_writable_descriptors(tmp_path, monkeypatch, copy_legacy):
    legacy = JsonSyncStateStore(tmp_path / "connector-state.json")
    kv_path = tmp_path / "connector-kv.json"
    if copy_legacy:
        legacy.path.write_text('{"version":1,"states":{}}')
        JsonKeyValueStore(kv_path).set("legacy", {"value": "preserved"})
    real_fsync = os.fsync

    def writable_fsync(fd):
        # Emulate Windows rejecting read-only descriptors, without changing bytes.
        os.write(fd, b"")
        real_fsync(fd)

    monkeypatch.setattr(os, "fsync", writable_fsync)
    state, kv = RuntimeStorageManager(legacy, kv_path).prepare("conn", "rti_a")
    assert state.path.is_file()
    assert kv.path.is_file()
    assert kv.get("legacy") == ({"value": "preserved"} if copy_legacy else None)
    if copy_legacy:
        assert state.path.read_bytes() == legacy.path.read_bytes()
        assert kv.path.read_bytes() == kv_path.read_bytes()


def test_full_copy_once_isolation_and_flush(tmp_path, monkeypatch):
    async def run():
        legacy = JsonSyncStateStore(tmp_path / "connector-state.json")
        old_kv = JsonKeyValueStore(tmp_path / "connector-kv.json")
        monkeypatch.setenv("AGENT_CONNECTOR_KV_FILE", str(old_kv.path))
        base = ConnectorRuntimeHost("conn", AsyncMock(), AsyncMock(), legacy)
        spec = RuntimeInstanceSpec(runtime_id="rti_a", runtime_type="dsh", name="A")
        old = RuntimeInstanceHost(base, spec)
        await old.sync_state_write("dsh/history/a", {"seq": 3})
        old_kv.set("legacy-value", {"a": 1})
        bound = await base.prepare_runtime_host("rti_a")
        scoped = RuntimeInstanceHost(bound, spec)
        assert await scoped.sync_state_read("dsh/history/a") == {"seq": 3}
        assert bound.runtime_kv.get("legacy-value") == {"a": 1}
        target = tmp_path / "conn" / "rti_a"
        assert (target / "sync-state.json").exists()
        assert (target / "kv.json").exists()
        await scoped.sync_state_delete("dsh/history/a")
        bound.runtime_kv.delete("legacy-value")
        await scoped.sync_state_write("dsh/history/new", {"seq": 9})
        assert base.flush_runtime_storage()
        # Neither a stopped runtime nor a fresh manager loses dirty state or
        # resurrects deletions from the retained legacy files.
        fresh = ConnectorRuntimeHost("conn", AsyncMock(), AsyncMock(), JsonSyncStateStore(legacy.path))
        restored = await fresh.prepare_runtime_host("rti_a")
        restored_scope = RuntimeInstanceHost(restored, spec)
        assert await restored_scope.sync_state_read("dsh/history/a") is None
        assert await restored_scope.sync_state_read("dsh/history/new") == {"seq": 9}
        assert restored.runtime_kv.get("legacy-value") is None
        assert old_kv.get("legacy-value") == {"a": 1}
        other = await fresh.prepare_runtime_host("rti_b")
        other_scope = RuntimeInstanceHost(other, RuntimeInstanceSpec(runtime_id="rti_b", runtime_type="dsh", name="B"))
        assert await other_scope.sync_state_read("dsh/history/new") is None
        other.runtime_kv.set("same-key", {"owner": "b"})
        assert restored.runtime_kv.get("same-key") is None
        another_connector = RuntimeStorageManager(legacy, old_kv.path)
        _, another_kv = another_connector.prepare("other-connector", "rti_a")
        assert another_kv.get("same-key") is None
    asyncio.run(run())


def test_copy_failure_can_retry_without_publishing_partial_directory(tmp_path, monkeypatch):
    legacy = JsonSyncStateStore(tmp_path / "connector-state.json")
    kv_path = tmp_path / "connector-kv.json"
    kv_path.write_text("broken")
    manager = RuntimeStorageManager(legacy, kv_path)
    with pytest.raises(RuntimeError):
        manager.prepare("conn", "rti_a")
    assert not (tmp_path / "conn" / "rti_a").exists()
    kv_path.write_text('{"version":1,"values":{}}')
    state, kv = manager.prepare("conn", "rti_a")
    assert state.path.exists() and kv.path.exists()
    assert manager.prepare("conn", "rti_a") == (state, kv)


@pytest.mark.parametrize("identity", ["../escape", "/absolute", "..", "a/b", "a\\b"])
def test_directory_identity_cannot_escape_root(tmp_path, identity):
    manager = RuntimeStorageManager(JsonSyncStateStore(tmp_path / "state.json"))
    with pytest.raises(ValueError):
        manager.prepare("conn", identity)


def test_source_isolation_preserves_existing_keys(tmp_path):
    async def run():
        base = ConnectorRuntimeHost("conn", AsyncMock(), AsyncMock(), JsonSyncStateStore(tmp_path / "state.json"))
        bound = await base.prepare_runtime_host("rti_a")
        spec = RuntimeInstanceSpec(runtime_id="rti_a", runtime_type="dsh", name="A")
        a = RuntimeInstanceHost(bound, spec, RuntimeSourceKey(kind="home", key="/a"))
        b = RuntimeInstanceHost(bound, spec, RuntimeSourceKey(kind="home", key="/b"))
        await a.sync_state_write("dsh/history/x", {"seq": 1})
        assert await b.sync_state_read("dsh/history/x") is None
    asyncio.run(run())
