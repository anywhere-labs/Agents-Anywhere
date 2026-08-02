from __future__ import annotations

from connector.paths import _merge_legacy_data_dir


def test_merge_legacy_data_dir_keeps_files_and_discards_sqlite(tmp_path) -> None:
    legacy = tmp_path / ".agent-server"
    canonical = tmp_path / ".agents-anywhere"
    legacy.mkdir()
    canonical.mkdir()
    (legacy / "connector.json").write_text("old")
    (canonical / "connector.json").write_text("new")
    (legacy / "connector-runtime.json").write_text("runtime")
    (legacy / "connector-state.sqlite3").write_text("database")
    (legacy / "connector-state.sqlite3-wal").write_text("wal")

    _merge_legacy_data_dir(legacy, canonical)

    assert not legacy.exists()
    assert (canonical / "connector.json").read_text() == "new"
    assert (canonical / "connector.json.legacy-1").read_text() == "old"
    assert (canonical / "connector-runtime.json").read_text() == "runtime"
    assert not (canonical / "connector-state.sqlite3").exists()
