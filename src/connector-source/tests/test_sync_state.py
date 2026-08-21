from __future__ import annotations

import json

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

    state = JsonSyncStateStore(path).get("codex", "connector-1", "thread-1")
    assert state is not None
    assert state.fingerprint == {"marker": "one"}
    assert state.cursor == {"position": 2}
    assert state.metadata == {"name": "Demo"}
    assert json.loads(path.read_text())["version"] == 1
    assert path.stat().st_mode & 0o777 == 0o600

    store.delete_runtime("codex", "connector-1")
    assert store.get("codex", "connector-1", "thread-1") is None


def test_json_sync_state_deletes_one_key(tmp_path) -> None:
    path = tmp_path / "connector-state.json"
    store = JsonSyncStateStore(path)
    store.set("codex", "connector-1", "thread-1", cursor={"position": 1})
    store.set("codex", "connector-1", "thread-2", cursor={"position": 2})

    store.delete("codex", "connector-1", "thread-1")

    assert store.get("codex", "connector-1", "thread-1") is None
    assert store.get("codex", "connector-1", "thread-2") is not None


def test_json_sync_state_rejects_invalid_document(tmp_path) -> None:
    path = tmp_path / "connector-state.json"
    path.write_text("not json")

    store = JsonSyncStateStore(path)

    try:
        store.get("codex", "connector-1", "thread-1")
    except RuntimeError as exc:
        assert "invalid connector sync state file" in str(exc)
    else:
        raise AssertionError("invalid state should not be silently replaced")
