from __future__ import annotations

import json
from pathlib import Path

from connector.claude.watcher import FileCursor, read_new_events


def _write(path: Path, lines: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8")


def _append(path: Path, lines: list[dict]) -> None:
    with path.open("a", encoding="utf-8") as fh:
        for line in lines:
            fh.write(json.dumps(line) + "\n")


def test_returns_empty_when_file_unchanged(tmp_path: Path) -> None:
    p = tmp_path / "a.jsonl"
    _write(p, [{"type": "user", "uuid": "u1"}])
    cursor = FileCursor(path=p)
    first = read_new_events(cursor)
    assert len(first) == 1
    second = read_new_events(cursor)
    assert second == []


def test_returns_only_appended_lines(tmp_path: Path) -> None:
    p = tmp_path / "a.jsonl"
    _write(p, [{"type": "user", "uuid": "u1"}])
    cursor = FileCursor(path=p)
    read_new_events(cursor)  # consume first batch
    _append(p, [{"type": "assistant", "uuid": "a1"}, {"type": "user", "uuid": "u2"}])
    new = read_new_events(cursor)
    assert [e["uuid"] for e in new] == ["a1", "u2"]


def test_partial_trailing_line_is_held_back(tmp_path: Path) -> None:
    p = tmp_path / "a.jsonl"
    _write(p, [{"type": "user", "uuid": "u1"}])
    cursor = FileCursor(path=p)
    read_new_events(cursor)  # consume
    # Append a complete line and then a partial (no trailing newline).
    with p.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "assistant", "uuid": "a1"}) + "\n")
        fh.write('{"type": "user", "uuid": "u2",')  # truncated, no newline
    new = read_new_events(cursor)
    assert [e["uuid"] for e in new] == ["a1"]
    # Once the partial completes...
    with p.open("a", encoding="utf-8") as fh:
        fh.write(' "message": {}}\n')
    new2 = read_new_events(cursor)
    assert [e["uuid"] for e in new2] == ["u2"]


def test_handles_missing_file(tmp_path: Path) -> None:
    cursor = FileCursor(path=tmp_path / "no-such.jsonl")
    assert read_new_events(cursor) == []


def test_handles_truncation(tmp_path: Path) -> None:
    p = tmp_path / "a.jsonl"
    _write(p, [{"type": "user", "uuid": "u1"}, {"type": "assistant", "uuid": "a1"}])
    cursor = FileCursor(path=p)
    read_new_events(cursor)
    # Truncate (rotation case).
    _write(p, [{"type": "user", "uuid": "u_new"}])
    new = read_new_events(cursor)
    assert [e["uuid"] for e in new] == ["u_new"]


def test_skips_malformed_json_lines(tmp_path: Path) -> None:
    p = tmp_path / "a.jsonl"
    p.write_text(
        '{"type": "user", "uuid": "u1"}\n'
        'not-json-at-all\n'
        '{"type": "assistant", "uuid": "a1"}\n',
        encoding="utf-8",
    )
    cursor = FileCursor(path=p)
    events = read_new_events(cursor)
    assert [e["uuid"] for e in events] == ["u1", "a1"]
