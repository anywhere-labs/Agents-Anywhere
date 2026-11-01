"""Antigravity native history scanning and projection with fixture databases."""

import sqlite3

import pytest

from connector.runtimes.acp.domain.definitions import AcpError
from connector.runtimes.antigravity.native_history import (
    discover_sessions,
    read_history,
    timeline,
)

SUMMARIES_SCHEMA = """
CREATE TABLE conversation_summaries (
    conversation_id text PRIMARY KEY, title text DEFAULT "", preview text DEFAULT "",
    step_count integer DEFAULT 0, last_modified_time datetime,
    workspace_uris text DEFAULT "", status text DEFAULT "", source text DEFAULT "",
    project_id text DEFAULT "", agent_name text DEFAULT "",
    parent_conversation_id text DEFAULT "", nesting_depth integer DEFAULT 0,
    battle_id text DEFAULT "", winning_conversation_id text DEFAULT "",
    not_fully_idle numeric DEFAULT 0, killed numeric DEFAULT 0,
    last_user_input_time datetime, last_user_input_step_index integer DEFAULT -1,
    app_data_dir text DEFAULT "", raw_summary blob, group_id text DEFAULT ""
);
"""
STEPS_SCHEMA = """
CREATE TABLE steps (
    idx integer PRIMARY KEY, step_type integer DEFAULT 0, status integer DEFAULT 0,
    has_subtrajectory numeric DEFAULT 0, metadata blob, error_details blob,
    permissions blob, task_details blob, render_info blob, step_payload blob,
    step_format integer DEFAULT 0
);
"""


def varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def field_string(number: int, text: str) -> bytes:
    data = text.encode("utf-8")
    return varint((number << 3) | 2) + varint(len(data)) + data


def build_summaries(path, rows):
    conn = sqlite3.connect(path)
    conn.executescript(SUMMARIES_SCHEMA)
    conn.executemany(
        "INSERT INTO conversation_summaries (conversation_id, title, preview, step_count,"
        " last_modified_time, workspace_uris, parent_conversation_id, nesting_depth, killed)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )
    conn.commit()
    conn.close()


def build_conversation(path, steps):
    conn = sqlite3.connect(path)
    conn.executescript(STEPS_SCHEMA)
    conn.executemany(
        "INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)",
        steps,
    )
    conn.commit()
    conn.close()


@pytest.fixture
def workspace(tmp_path):
    directory = tmp_path / "proj"
    directory.mkdir()
    return directory


def test_discover_filters_subagents_and_killed(tmp_path, workspace):
    import json

    db = tmp_path / "conversation_summaries.db"
    uris = json.dumps([f"file://{workspace}"])
    build_summaries(
        db,
        [
            ("conv-main", "周报制作", "预览文本", 12, "2026-11-01 10:00:00", uris, "", 0, 0),
            ("conv-sub", "子代理", "", 3, "2026-11-01 10:00:01", uris, "conv-main", 1, 0),
            ("conv-dead", "被终止", "", 3, "2026-11-01 10:00:02", uris, "", 0, 1),
        ],
    )
    inventory = discover_sessions(db)
    assert set(inventory) == {"conv-main"}
    entry = inventory["conv-main"]
    assert entry["title"] == "周报制作"
    assert entry["cwd"] == str(workspace)
    assert entry["signature"] == "2026-11-01 10:00:00:12"


def test_discover_missing_db_is_empty(tmp_path):
    assert discover_sessions(tmp_path / "none.db") == {}


def test_timeline_maps_user_assistant_and_tools(tmp_path, workspace):
    import json

    summaries = tmp_path / "conversation_summaries.db"
    uris = json.dumps([f"file://{workspace}"])
    build_summaries(
        summaries,
        [("conv-1", "标题", "预览", 3, "2026-11-01 11:00:00", uris, "", 0, 0)],
    )
    convo_dir = tmp_path / "conversations"
    convo_dir.mkdir()
    user_payload = field_string(2, "请检查本项目")
    inner = (
        field_string(1, "已完整研读交接文档，以下是结论与建议，内容足够长以越过过滤阈值。")
        + varint((2 << 3) | 0)
        + varint(123456)  # 真实嵌套消息含 varint 字段，迫使走子消息递归
    )
    assistant_payload = varint((1 << 3) | 2) + varint(len(inner)) + inner
    tool_payload = (
        field_string(1, "call_1001")
        + field_string(2, "run_command")
        + field_string(3, '{"CommandLine":"ls -la"}')
    )
    build_conversation(
        convo_dir / "conv-1.db",
        [
            (0, 14, user_payload),
            (1, 15, assistant_payload),
            (2, 132, tool_payload),
        ],
    )
    history = read_history(summaries, convo_dir, "conv-1")
    assert history.title == "标题"
    assert history.complete is True
    items = timeline(history, "platform-1")
    kinds = [(item["type"], item["role"], item["status"]) for item in items]
    assert ("message", "user", "done") in kinds
    assert ("message", "assistant", "done") in kinds
    assert ("tool", "tool", "done") in kinds
    texts = [item["content"]["text"] for item in items if item["type"] == "message"]
    assert "请检查本项目" in texts[0]
    assert any("已完整研读交接文档" in text for text in texts)
    tool = next(item for item in items if item["type"] == "tool")
    assert tool["content"]["kind"] == "command"
    assert tool["content"]["command"] == "ls -la"
    assert all(item["source"]["origin"] == "antigravity_native_history" for item in items)


def test_read_history_missing_conversation(tmp_path, workspace):
    import json

    summaries = tmp_path / "conversation_summaries.db"
    uris = json.dumps([f"file://{workspace}"])
    build_summaries(
        summaries,
        [("conv-1", "标题", "", 1, "2026-11-01 11:00:00", uris, "", 0, 0)],
    )
    convo_dir = tmp_path / "conversations"
    convo_dir.mkdir()
    with pytest.raises(AcpError) as excinfo:
        read_history(summaries, convo_dir, "conv-none")
    assert excinfo.value.code == "antigravity_source_missing"


def test_require_resumable_checks_workspace(tmp_path):
    import json

    summaries = tmp_path / "conversation_summaries.db"
    uris = json.dumps([f"file://{tmp_path / 'gone'}"])
    build_summaries(
        summaries,
        [("conv-1", "标题", "", 1, "2026-11-01 11:00:00", uris, "", 0, 0)],
    )
    convo_dir = tmp_path / "conversations"
    convo_dir.mkdir()
    build_conversation(
        convo_dir / "conv-1.db",
        [(0, 14, field_string(2, "请检查本项目"))],
    )
    history = read_history(summaries, convo_dir, "conv-1")
    with pytest.raises(AcpError) as excinfo:
        history.require_resumable()
    assert excinfo.value.code == "antigravity_workspace_missing"
