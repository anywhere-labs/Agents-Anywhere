from __future__ import annotations

import json
import threading

from connector.server.sync_state import JsonSyncStateStore


def test_json_sync_state_round_trip_and_delete(tmp_path) -> None:
    path = tmp_path / "connector-state.json"
    store = JsonSyncStateStore(path)

    store.set(
        "codex",
        "connector-1",
        "thread-1",
        fingerprint={"marker": "one"},
        cursor={"position": 2},
        metadata={"name": "Demo"},
    )

    assert not path.exists()
    assert store.flush() is True
    state = JsonSyncStateStore(path).get("codex", "connector-1", "thread-1")
    assert state is not None
    assert state.fingerprint == {"marker": "one"}
    assert state.cursor == {"position": 2}
    assert state.metadata == {"name": "Demo"}
    assert json.loads(path.read_text())["version"] == 1
    assert path.stat().st_mode & 0o777 == 0o600

    store.delete_runtime("codex", "connector-1")
    assert store.get("codex", "connector-1", "thread-1") is None
    assert store.flush() is True
    assert JsonSyncStateStore(path).get("codex", "connector-1", "thread-1") is None


def test_json_sync_state_deletes_one_key(tmp_path) -> None:
    path = tmp_path / "connector-state.json"
    store = JsonSyncStateStore(path)
    store.set("codex", "connector-1", "thread-1", cursor={"position": 1})
    store.set("codex", "connector-1", "thread-2", cursor={"position": 2})

    store.delete("codex", "connector-1", "thread-1")

    assert store.get("codex", "connector-1", "thread-1") is None
    assert store.get("codex", "connector-1", "thread-2") is not None
    assert store.flush() is True
    restored = JsonSyncStateStore(path)
    assert restored.get("codex", "connector-1", "thread-1") is None
    assert restored.get("codex", "connector-1", "thread-2") is not None


def test_json_sync_state_rejects_invalid_document(tmp_path) -> None:
    path = tmp_path / "connector-state.json"
    path.write_text("not json")

    try:
        JsonSyncStateStore(path)
    except RuntimeError as exc:
        assert "invalid connector sync state file" in str(exc)
    else:
        raise AssertionError("invalid state should not be silently replaced")


def test_json_sync_state_reads_file_once_and_skips_unchanged_flush(tmp_path) -> None:
    path = tmp_path / "connector-state.json"
    initial = JsonSyncStateStore(path)
    initial.set("codex", "connector-1", "thread-1", cursor={"position": 1})
    assert initial.flush() is True

    store = JsonSyncStateStore(path)

    def fail_if_read_again() -> dict:
        raise AssertionError(
            "sync state file should only be read during initialization"
        )

    store._read = fail_if_read_again  # type: ignore[method-assign]
    assert store.get("codex", "connector-1", "thread-1") is not None
    store.set("codex", "connector-1", "thread-1", cursor={"position": 1})
    assert store.flush() is False

    store.set("codex", "connector-1", "thread-1", cursor={"position": 2})
    assert store.flush() is True


def test_json_sync_state_copies_values_at_the_memory_boundary(tmp_path) -> None:
    store = JsonSyncStateStore(tmp_path / "connector-state.json")
    cursor = {"nested": {"position": 1}}
    store.set("codex", "connector-1", "thread-1", cursor=cursor)

    cursor["nested"]["position"] = 2
    first = store.get("codex", "connector-1", "thread-1")
    assert first is not None
    assert first.cursor == {"nested": {"position": 1}}

    assert first.cursor is not None
    first.cursor["nested"]["position"] = 3
    second = store.get("codex", "connector-1", "thread-1")
    assert second is not None
    assert second.cursor == {"nested": {"position": 1}}


def test_json_sync_state_preserves_changes_made_during_flush(tmp_path) -> None:
    class BlockingJsonSyncStateStore(JsonSyncStateStore):
        def __init__(self, path) -> None:
            self.write_started = threading.Event()
            self.allow_write = threading.Event()
            super().__init__(path)

        def _write(self, document) -> None:
            self.write_started.set()
            assert self.allow_write.wait(timeout=2)
            super()._write(document)

    path = tmp_path / "connector-state.json"
    store = BlockingJsonSyncStateStore(path)
    store.set("codex", "connector-1", "thread-1", cursor={"position": 1})
    flush_results: list[bool] = []
    flush_thread = threading.Thread(target=lambda: flush_results.append(store.flush()))

    flush_thread.start()
    assert store.write_started.wait(timeout=2)
    store.set("codex", "connector-1", "thread-2", cursor={"position": 2})
    store.allow_write.set()
    flush_thread.join(timeout=2)

    assert not flush_thread.is_alive()
    assert flush_results == [True]
    assert store.flush() is True
    restored = JsonSyncStateStore(path)
    assert restored.get("codex", "connector-1", "thread-1") is not None
    assert restored.get("codex", "connector-1", "thread-2") is not None
