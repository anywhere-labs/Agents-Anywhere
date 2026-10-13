from __future__ import annotations

import json
from pathlib import Path

from connector.runtimes.pi.sessions import SessionDirectory, load_session_doc


def write_session(
    path: Path, *, name: str | None = None, parent: str | None = None, cwd: str = "/tmp/project"
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [
        {
            "type": "session",
            "version": 3,
            "id": "session-uuid-1",
            "timestamp": "2026-01-01T00:00:00.000Z",
            "cwd": cwd,
        }
    ]
    if name:
        lines.append(
            {
                "type": "session_info",
                "id": "info0001",
                "parentId": None,
                "timestamp": "2026-01-01T00:00:01.000Z",
                "name": name,
            }
        )
    lines.extend(
        [
            {
                "type": "message",
                "id": "ent00001",
                "parentId": "info0001" if name else None,
                "timestamp": "2026-01-01T00:00:02.000Z",
                "message": {
                    "role": "user",
                    "content": "请帮我改一下这个 bug",
                    "timestamp": 1767225602000,
                },
            },
            {
                "type": "message",
                "id": "ent00002",
                "parentId": "ent00001",
                "timestamp": "2026-01-01T00:00:03.000Z",
                "message": {
                    "role": "assistant",
                    "content": [{"type": "text", "text": "好的"}],
                    "provider": "test",
                    "model": "test-model",
                    "stopReason": "stop",
                    "usage": {
                        "input": 1,
                        "output": 1,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "totalTokens": 2,
                        "cost": {
                            "input": 0,
                            "output": 0,
                            "cacheRead": 0,
                            "cacheWrite": 0,
                            "total": 0,
                        },
                    },
                    "timestamp": 1767225603000,
                },
            },
        ]
    )
    if parent:
        lines[0]["parentSession"] = parent
    path.write_text("\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n")


def test_scan_and_summarize(tmp_path: Path) -> None:
    session = tmp_path / "sessions" / "--tmp-project--" / "2026_sess.jsonl"
    write_session(session, name="我的会话")
    directory = SessionDirectory(tmp_path / "sessions")
    summaries = directory.list_sessions()
    assert len(summaries) == 1
    summary = summaries[0]
    assert summary.session_id == "session-uuid-1"
    assert summary.cwd == "/tmp/project"
    assert summary.title == "我的会话"
    assert summary.path == str(session)


def test_title_falls_back_to_first_user_message(tmp_path: Path) -> None:
    session = tmp_path / "sessions" / "a" / "s.jsonl"
    write_session(session)
    directory = SessionDirectory(tmp_path / "sessions")
    summaries = directory.list_sessions()
    assert summaries[0].title == "请帮我改一下这个 bug"


def test_placeholder_session_name_falls_back_to_first_message(tmp_path: Path) -> None:
    """AA's default composer title must not shadow the first-message title."""

    session = tmp_path / "sessions" / "a" / "s.jsonl"
    write_session(session, name="新建会话")
    directory = SessionDirectory(tmp_path / "sessions")
    summaries = directory.list_sessions()
    assert summaries[0].title == "请帮我改一下这个 bug"


def test_load_active_branch(tmp_path: Path) -> None:
    session = tmp_path / "sessions" / "a" / "s.jsonl"
    write_session(session)
    doc = load_session_doc(session)
    assert doc is not None
    assert doc.summary.path == str(session)
    types = [entry["type"] for entry in doc.entries]
    assert types == ["message", "message"]
    assert doc.entries[1]["message"]["role"] == "assistant"


def test_load_active_branch_follows_parent_links(tmp_path: Path) -> None:
    session = tmp_path / "sessions" / "a" / "tree.jsonl"
    session.parent.mkdir(parents=True, exist_ok=True)
    entries = [
        {"type": "session", "version": 3, "id": "s1", "timestamp": "t", "cwd": "/tmp"},
        {
            "type": "message",
            "id": "a1",
            "parentId": None,
            "timestamp": "t",
            "message": {"role": "user", "content": "root", "timestamp": 1},
        },
        {
            "type": "message",
            "id": "b1",
            "parentId": "a1",
            "timestamp": "t",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "left"}],
                "timestamp": 2,
            },
        },
        {
            "type": "message",
            "id": "c1",
            "parentId": "a1",
            "timestamp": "t",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "right"}],
                "timestamp": 3,
            },
        },
    ]
    session.write_text("\n".join(json.dumps(entry) for entry in entries) + "\n")
    doc = load_session_doc(session)
    assert doc is not None
    ids = [entry["id"] for entry in doc.entries]
    # The active branch follows the last entry's parents, not file order of branches.
    assert ids == ["a1", "c1"]
