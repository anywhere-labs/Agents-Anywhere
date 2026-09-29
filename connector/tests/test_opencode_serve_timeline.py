"""Tests for projecting the host service's stored messages into timeline items.

The fixtures are transcriptions of what a live 2.0.18 service actually returned
(`docs/opencode-server-surface.md` §4.1): a tool part answers through
`state.content` as a `Tool.Content` array, `finish: "error"` arrives as an
assistant message with `content: []` plus an `error` object, subagent results
arrive as `synthetic` messages whose `metadata.source` is `"subagent"`, and a
649-message session contained 101 `idle` messages against 46 `user` ones.
"""

from __future__ import annotations

from typing import Any

from connector.runtime_protocol.timeline import timeline_content_hash
from connector.runtimes.opencode.serve.timeline import project_messages, timeline_item_id

SESSION = "ses_probe"


def sample() -> list[dict[str, Any]]:
    return [
        {"id": "msg_u1", "type": "user", "text": "继续", "time": {"created": 1}},
        {
            "id": "msg_a1",
            "type": "assistant",
            "agent": "team",
            "model": {"id": "glm-5.3", "providerID": "lxns-uni", "variant": "max"},
            "time": {"created": 2},
            "content": [
                {"type": "reasoning", "text": "先看目录", "time": {"created": 2}},
                {"type": "text", "text": "**根因确认**"},
                {
                    "type": "tool",
                    "id": "chatcmpl-tool-943078",
                    "name": "read",
                    "executed": False,
                    "state": {
                        "status": "completed",
                        "input": {"path": "D:\\work\\repo"},
                        "content": [{"type": "text", "text": "README.md\nsrc\\"}],
                        "metadata": {"truncated": False},
                    },
                    "time": {"created": 3},
                },
            ],
        },
        {"id": "msg_i1", "type": "idle", "outcome": "interrupted", "time": {"created": 4}},
    ]


def project(rows: list[dict[str, Any]]):
    return project_messages(rows, session_id=SESSION).items


def types_and_roles(items: object) -> list[tuple[str, str | None]]:
    return [(item.type, item.role) for item in items]  # type: ignore[attr-defined]


def test_projects_a_turn_in_stored_order() -> None:
    items = project(sample())
    assert types_and_roles(items) == [
        ("turn.start", "user"),
        ("message", "user"),
        ("system", "assistant"),
        ("message", "assistant"),
        ("tool", "tool"),
        ("turn.end", None),
    ]
    assert [item.order_seq for item in items] == [1, 2, 3, 4, 5, 6]
    assert items[2].content["kind"] == "reasoning", "thinking must be distinguishable without an item metadata column"
    assert items[2].content["text"] == "先看目录"
    assert items[2].metadata["reasoning"] is True
    assert items[3].content["text"] == "**根因确认**"
    assert "reasoning" not in items[3].metadata


def test_tool_item_keeps_the_native_identity_and_io() -> None:
    tool = project(sample())[4]
    assert tool.content["kind"] == "tool_call"
    assert tool.content["title"] == "read"
    assert tool.content["input"] == {"path": "D:\\work\\repo"}
    # The answer is `state.content` verbatim: reading `output`/`result` instead
    # produced tool rows with a title and nothing else on every real session.
    assert tool.content["output"] == [{"type": "text", "text": "README.md\nsrc\\"}]
    assert tool.status == "done"
    assert tool.metadata["nativeToolId"] == "chatcmpl-tool-943078"
    assert tool.metadata["messageId"] == "msg_a1"
    assert tool.metadata["executed"] is False
    assert tool.source["itemId"] == "chatcmpl-tool-943078"


def test_a_failed_tool_call_carries_its_error_and_failed_status() -> None:
    rows = sample()
    rows[1]["content"][2]["state"] = {
        "status": "error",
        "input": {"path": "missing"},
        "error": {"type": "not_found", "message": "no such file"},
    }
    tool = project(rows)[4]
    assert tool.status == "failed"
    assert tool.content["error"] == {"type": "not_found", "message": "no such file"}


def test_an_in_flight_tool_call_is_not_reported_as_finished() -> None:
    rows = sample()
    rows[1]["content"][2]["state"] = {"status": "streaming", "input": '{"path":'}
    tool = project(rows)[4]
    assert tool.status == "running"
    assert "nativeStatus" not in tool.metadata, "a status the mapping knows needs no escape hatch"


def test_an_unknown_tool_status_is_reported_as_done_with_the_native_value_kept() -> None:
    rows = sample()
    rows[1]["content"][2]["state"] = {"status": "queued", "input": {}}
    tool = project(rows)[4]
    assert (tool.status, tool.metadata["nativeStatus"]) == ("done", "queued")


def test_turn_linkage_and_idle_outcome() -> None:
    items = project(sample())
    start, end = items[0], items[-1]
    assert start.type == "turn.start" and end.type == "turn.end"
    # Everything inside the turn points back at the opening marker.
    for item in items[1:-1]:
        assert item.turn_id == start.id
    assert end.turn_id == start.id
    assert end.status == "interrupted", "the stored idle outcome must survive, not be flattened to done"
    assert end.metadata["outcome"] == "interrupted"


def test_idle_outcomes_map_to_their_own_status() -> None:
    for outcome, status in (("succeeded", "done"), ("failed", "failed"), ("interrupted", "interrupted")):
        rows = sample()
        rows[-1] = {"id": "msg_i2", "type": "idle", "outcome": outcome}
        assert project(rows)[-1].status == status, outcome


def test_an_idle_without_an_open_turn_does_not_end_the_next_turn() -> None:
    # Measured: a step boundary idles without any user turn being open (101
    # idles against 46 users). Emitting it anyway yields an orphan turn.end.
    rows = [{"id": "msg_i0", "type": "idle", "outcome": "succeeded"}] + sample()
    items = project(rows)
    assert [item.type for item in items if item.type == "turn.end"] == ["turn.end"]
    assert items[0].type == "turn.start"
    skipped = project_messages(rows, session_id=SESSION).skipped
    assert skipped["idle_without_turn"] == 1


def test_unrecognised_message_types_are_counted_not_dropped_silently() -> None:
    rows = sample() + [{"id": "msg_z", "type": "compaction-v3", "time": {"created": 9}}]
    result = project_messages(rows, session_id=SESSION)
    assert result.skipped["compaction-v3"] == 1


def test_model_switch_becomes_a_marker_with_both_ends() -> None:
    rows = sample() + [
        {
            "id": "msg_m1",
            "type": "model-switched",
            "time": {"created": 5},
            "model": {"id": "glm-5.3", "providerID": "volcengine", "variant": "max"},
            "previous": {"id": "GLM-5.3", "providerID": "lxns-uni"},
        }
    ]
    marker = project(rows)[-1]
    assert (marker.type, marker.status) == ("marker", "done")
    assert marker.content["kind"] == "system"
    assert marker.content["label"] == "model → volcengine/glm-5.3"


def test_compaction_shows_as_a_compact_marker_with_its_summary() -> None:
    rows = sample() + [
        {
            "id": "msg_c1",
            "type": "compaction",
            "time": {"created": 6},
            "status": "completed",
            "reason": "manual",
            "summary": "## Objective\n- keep going",
        }
    ]
    marker = project(rows)[-1]
    assert (marker.type, marker.content["kind"]) == ("marker", "compact")
    assert marker.content["text"] == "## Objective\n- keep going"
    assert "manual" in marker.content["label"]


def test_an_assistant_fault_with_no_parts_is_still_visible() -> None:
    rows = sample()
    rows.insert(1, {"id": "msg_f1", "type": "assistant", "finish": "error", "content": [], "error": {"type": "aborted", "message": "Step interrupted"}})
    fault = project(rows)[2]
    assert (fault.type, fault.status, fault.content["kind"]) == ("system", "failed", "error")
    assert fault.content["text"] == "Step interrupted"
    assert fault.metadata["nativeType"] == "aborted"


def test_subagent_provenance_survives_projection() -> None:
    rows = sample()
    rows.insert(1, {
        "id": "msg_s1",
        "type": "synthetic",
        "time": {"created": 2},
        "text": '<subagent sessionID="ses_kid" state="completed" description="调研"/>',
        "metadata": {"source": "subagent", "childID": "ses_kid", "agent": "researcher", "state": "completed"},
    })
    synthetic = project(rows)[2]
    assert synthetic.role == "system"
    assert synthetic.metadata["childID"] == "ses_kid"
    assert synthetic.metadata["agent"] == "researcher"


def test_skill_and_shell_messages_are_projected_as_tool_rows() -> None:
    rows = [
        {"id": "msg_k1", "type": "skill", "time": {"created": 1}, "skill": "pdf", "name": "Read a PDF", "text": "loaded"},
        {"id": "msg_b1", "type": "shell", "time": {"created": 2}, "shellID": "sh1", "command": "ls", "status": "exited", "exit": 0, "output": {"text": "a\nb"}},
        {"id": "msg_i1", "type": "idle", "outcome": "succeeded"},
    ]
    skill, shell = project(rows)[:2]
    assert (skill.content["kind"], skill.content["title"], skill.content["output"]) == ("tool_call", "skill Read a PDF", "loaded")
    assert skill.metadata["skill"] is True
    assert (shell.content["kind"], shell.content["command"], shell.content["exitCode"], shell.status) == ("command", "ls", 0, "done")
    assert shell.content["output"] == {"text": "a\nb"}


def test_content_hash_is_the_canonical_one_the_decoder_recomputes() -> None:
    for item in project(sample()):
        assert item.content_hash == timeline_content_hash(item.type, item.status, item.role, item.content)


def test_ids_are_stable_across_projections() -> None:
    first = project(sample())
    second = project(sample())
    assert [item.id for item in first] == [item.id for item in second]
    assert first[1].id == timeline_item_id("user:msg_u1")


def test_two_tool_calls_sharing_a_native_id_stay_distinct_rows() -> None:
    # `chatcmpl-tool-*` ids repeat across messages in real sessions, and the Hub
    # rejects a timeline wholesale over one duplicate item id.
    rows = sample()
    rows[1]["content"][2]["id"] = "chatcmpl-tool-dup"
    rows.append({"id": "msg_a2", "type": "assistant", "content": [
        {"type": "tool", "id": "chatcmpl-tool-dup", "name": "read", "state": {"status": "completed", "input": {}, "content": []}}
    ]})
    rows.append({"id": "msg_i2", "type": "idle", "outcome": "succeeded"})
    items = project(rows)
    tool_ids = [item.id for item in items if item.type == "tool"]
    assert len(tool_ids) == 2
    assert len(set(tool_ids)) == 2


def test_garbage_rows_are_skipped_without_breaking_the_stream() -> None:
    rows = ["nope", {"type": "user"}, sample()[1], {"id": "msg_x", "type": "assistant", "content": "not-a-list"}]
    items = project(rows)
    # The assistant message yields reasoning (a `system` item) + text + tool; the
    # id-less user row and the string-content assistant are dropped.
    assert [item.type for item in items] == ["system", "message", "tool"]
