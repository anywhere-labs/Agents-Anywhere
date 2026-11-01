"""ZCode native history scanning and projection against fixture databases."""

import json
import sqlite3

import pytest

from connector.runtimes.acp.domain.definitions import AcpError
from connector.runtimes.zcode.native_history import (
    discover_sessions,
    read_history,
    timeline,
)

SCHEMA = """
CREATE TABLE session (
    id text primary key, title text, directory text,
    time_created integer, time_updated integer, time_deleted integer, task_type text
);
CREATE TABLE message (
    id text primary key, session_id text, sequence integer, data text, time_created integer
);
CREATE TABLE part (
    id text primary key, message_id text, sequence integer, data text, time_created integer
);
"""


def build_db(path, sessions=(), messages=(), parts=()):
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    conn.executemany(
        "INSERT INTO session (id, title, directory, time_created, time_updated, time_deleted, task_type)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        sessions,
    )
    conn.executemany(
        "INSERT INTO message (id, session_id, sequence, data, time_created) VALUES (?, ?, ?, ?, ?)",
        messages,
    )
    conn.executemany(
        "INSERT INTO part (id, message_id, sequence, data, time_created) VALUES (?, ?, ?, ?, ?)",
        parts,
    )
    conn.commit()
    conn.close()


def session_row(native_id, cwd, updated=100, deleted=None, task_type="interactive", title="标题"):
    return (native_id, title, cwd, 50, updated, deleted, task_type)


def message_row(message_id, native_id, sequence, data, created=60):
    return (message_id, native_id, sequence, json.dumps(data), created)


def part_row(part_id, message_id, sequence, data, created=70):
    return (part_id, message_id, sequence, json.dumps(data), created)


REAL_USER = {"origin": "real_user", "kind": "user_prompt", "uiVisibility": "visible"}
AGENT_REMINDER = {"origin": "agent_runtime", "kind": "system_reminder", "uiVisibility": "hidden"}


@pytest.fixture
def workspace(tmp_path):
    directory = tmp_path / "proj"
    directory.mkdir()
    return directory


def test_discover_only_importable_sessions(tmp_path, workspace):
    db = tmp_path / "db.sqlite"
    build_db(
        db,
        sessions=[
            session_row("sess-a", str(workspace), updated=110),
            session_row("sess-b", str(workspace), deleted=999),
            session_row("sess-c", str(workspace), task_type="subagent_child"),
        ],
    )
    inventory = discover_sessions(db)
    assert set(inventory) == {"sess-a"}
    assert inventory["sess-a"]["cwd"] == str(workspace)
    assert inventory["sess-a"]["signature"] == "110:0"


def test_discover_missing_db_is_empty(tmp_path):
    assert discover_sessions(tmp_path / "none.sqlite") == {}


def test_discover_rejects_unknown_schema(tmp_path):
    db = tmp_path / "db.sqlite"
    conn = sqlite3.connect(db)
    conn.executescript("CREATE TABLE session (id text, title text);")
    conn.commit()
    conn.close()
    with pytest.raises(AcpError) as excinfo:
        discover_sessions(db)
    assert excinfo.value.code == "zcode_history_invalid"


def test_read_history_groups_parts_in_order(tmp_path, workspace):
    db = tmp_path / "db.sqlite"
    build_db(
        db,
        sessions=[session_row("sess-a", str(workspace), updated=120)],
        messages=[
            message_row("m1", "sess-a", 1, {"role": "user", "time": {"created": 1}}),
            message_row(
                "m2", "sess-a", 2,
                {"role": "assistant", "time": {"created": 2, "completed": 3}},
            ),
        ],
        parts=[
            part_row("p1", "m2", 1, {"type": "step-start"}),
            part_row("p2", "m2", 2, {"type": "reasoning", "text": "想一想"}),
            part_row("p3", "m2", 3, {"type": "text", "text": "回答正文"}),
        ],
    )
    history = read_history(db, "sess-a")
    assert [entry["id"] for entry in history.entries] == ["m1", "m2"]
    assert [part["id"] for part in history.entries[1]["parts"]] == ["p1", "p2", "p3"]
    assert history.revision == "120:2"
    assert history.complete is True


def test_read_history_missing_session(tmp_path, workspace):
    db = tmp_path / "db.sqlite"
    build_db(db, sessions=[session_row("sess-a", str(workspace))])
    with pytest.raises(AcpError) as excinfo:
        read_history(db, "sess-none")
    assert excinfo.value.code == "zcode_source_missing"


def test_timeline_filters_injected_user_messages(tmp_path, workspace):
    db = tmp_path / "db.sqlite"
    build_db(
        db,
        sessions=[session_row("sess-a", str(workspace))],
        messages=[
            message_row("m1", "sess-a", 1, {"role": "user", "semantics": REAL_USER}),
            message_row("m2", "sess-a", 2, {"role": "user", "semantics": AGENT_REMINDER}),
            message_row("m3", "sess-a", 3, {"role": "user"}),
        ],
        parts=[
            part_row("p1", "m1", 1, {"type": "text", "text": "真实输入"}),
            part_row("p2", "m2", 1, {"type": "text", "text": "系统注入，不得出现"}),
            part_row("p3", "m3", 1, {"type": "text", "text": "无语义标记，宽容导入"}),
        ],
    )
    history = read_history(db, "sess-a")
    items = timeline(history, "platform-1")
    texts = [item["content"]["text"] for item in items]
    assert texts == ["真实输入", "无语义标记，宽容导入"]
    assert all(item["type"] == "message" and item["role"] == "user" for item in items)
    assert all(item["source"]["origin"] == "zcode_native_history" for item in items)


def test_timeline_assistant_parts_mapping(tmp_path, workspace):
    db = tmp_path / "db.sqlite"
    build_db(
        db,
        sessions=[session_row("sess-a", str(workspace))],
        messages=[
            message_row(
                "m1", "sess-a", 1,
                {"role": "assistant", "time": {"created": 1, "completed": 9}},
            ),
        ],
        parts=[
            part_row("p1", "m1", 1, {"type": "step-start"}),
            part_row("p2", "m1", 2, {"type": "reasoning", "text": "思考内容"}),
            part_row("p3", "m1", 3, {"type": "text", "text": "正文"}),
            part_row(
                "p4", "m1", 4,
                {"type": "text", "text": "内部指令", "synthetic": True},
            ),
            part_row(
                "p5", "m1", 5,
                {"type": "text", "text": "仅模型可见",
                 "metadata": {"visibility": "model-only"}},
            ),
            part_row(
                "p6", "m1", 6,
                {"type": "tool", "callID": "call-1", "tool": "Bash",
                 "state": {"status": "completed", "input": {"command": "ls -la"},
                           "title": "Bash", "output": "file.txt"}},
            ),
            part_row(
                "p7", "m1", 7,
                {"type": "tool", "callID": "call-2", "tool": "Read",
                 "state": {"status": "error", "input": {"file_path": "/x"},
                           "error": "not found"}},
            ),
            part_row(
                "p8", "m1", 8,
                {"type": "tool", "callID": "call-3", "tool": "Agent",
                 "state": {"status": "running", "input": {}}},
            ),
            part_row(
                "p9", "m1", 9,
                {"type": "file", "mime": "image/png", "url": "zcode-artifact://x"},
            ),
            part_row("p10", "m1", 10, {"type": "step-finish", "reason": "stop"}),
        ],
    )
    history = read_history(db, "sess-a")
    items = timeline(history, "platform-1")
    assert [item["status"] for item in items] == [
        "done", "done", "done", "failed", "running", "done",
    ]
    thinking, text, bash, failed_tool, running_tool, image = items
    assert thinking["content"]["isThinking"] is True
    assert thinking["content"]["text"] == "思考内容"
    assert text["content"]["text"] == "正文"
    assert bash["type"] == "tool"
    assert bash["content"]["kind"] == "command"
    assert bash["content"]["command"] == "ls -la"
    assert failed_tool["content"]["kind"] == "tool_call"
    assert running_tool["content"]["toolCallId"] == "call-3"
    assert image["content"]["text"] == "[图片]"
    assert [item["orderSeq"] for item in items] == list(range(1, len(items) + 1))


def test_timeline_ids_are_stable(tmp_path, workspace):
    db = tmp_path / "db.sqlite"
    build_db(
        db,
        sessions=[session_row("sess-a", str(workspace))],
        messages=[message_row("m1", "sess-a", 1, {"role": "user", "semantics": REAL_USER})],
        parts=[part_row("p1", "m1", 1, {"type": "text", "text": "稳定 id"})],
    )
    history = read_history(db, "sess-a")
    first = timeline(history, "platform-1")
    second = timeline(history, "platform-1")
    assert [item["id"] for item in first] == [item["id"] for item in second]
    assert all(item["contentHash"] for item in first)


def test_require_resumable_checks_workspace(tmp_path, workspace):
    db = tmp_path / "db.sqlite"
    build_db(
        db,
        sessions=[session_row("sess-a", str(tmp_path / "gone"))],
        messages=[message_row("m1", "sess-a", 1, {"role": "user", "semantics": REAL_USER})],
    )
    history = read_history(db, "sess-a")
    with pytest.raises(AcpError) as excinfo:
        history.require_resumable()
    assert excinfo.value.code == "zcode_workspace_missing"
