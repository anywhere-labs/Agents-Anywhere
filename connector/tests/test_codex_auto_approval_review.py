"""Codex automatic approval reviews must reach the Timeline as readable markers."""

from typing import Any

import pytest

from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator
from connector.runtimes.codex.timeline.raw_content import timeline_item_content

THREAD = "thread-auto-review"
TURN = "turn-auto-review"


def review_item(status: str, **overrides: Any) -> dict[str, Any]:
    """The item Codex Desktop stores for ``item/autoApprovalReview/*``."""

    item: dict[str, Any] = {
        "type": "automaticApprovalReview",
        "id": "automatic-approval-review:review-1",
        "targetItemId": "call_rm",
        "turnId": TURN,
        "action": {
            "type": "command",
            "source": "shell",
            "command": "rm -rf build",
            "cwd": "/workspace",
        },
        "startedAtMs": 1,
        "completedAtMs": None if status == "inProgress" else 2,
        "serverStartedAtMs": 1,
        "serverCompletedAtMs": None if status == "inProgress" else 2,
        "event": None,
        "status": status,
        "riskLevel": None,
        "userAuthorization": None,
        "rationale": None,
    }
    item.update(overrides)
    return item


def snapshot_items(*items: dict[str, Any]):
    return CodexTimelineAccumulator().items_from_thread_snapshot(
        session_id="sess",
        external_session_id=THREAD,
        thread={"turns": [{"id": TURN, "status": "completed", "items": list(items)}]},
        limit=None,
    )


def test_history_replay_projects_denied_review_as_readable_marker() -> None:
    (item,) = snapshot_items(
        review_item(
            "denied",
            riskLevel="high",
            userAuthorization="low",
            rationale="Deletes files outside the requested change.",
        )
    )

    assert item.type == "marker"
    assert item.status == "failed"
    assert item.role == "system"
    assert item.turn_id == TURN
    assert item.source["rawType"] == "automaticApprovalReview"
    assert item.source["itemId"] == "automatic-approval-review:review-1"
    assert item.content == {
        "kind": "system",
        "label": "自动审查已拒绝高风险操作：运行 rm -rf build",
        "text": "Deletes files outside the requested change.",
        "severity": "warning",
        "review": {
            "status": "denied",
            "riskLevel": "high",
            "userAuthorization": "low",
            "rationale": "Deletes files outside the requested change.",
        },
        "action": {
            "type": "command",
            "source": "shell",
            "command": "rm -rf build",
            "cwd": "/workspace",
        },
        "targetItemId": "call_rm",
    }


@pytest.mark.parametrize(
    ("status", "item_status", "label"),
    [
        ("inProgress", "running", "自动审查中：运行 rm -rf build"),
        ("approved", "done", "自动审查已批准：运行 rm -rf build"),
        ("denied", "failed", "自动审查已拒绝：运行 rm -rf build"),
        ("timedOut", "failed", "自动审查超时：运行 rm -rf build"),
        ("aborted", "cancelled", "自动审查已中止：运行 rm -rf build"),
    ],
)
def test_review_status_drives_marker_status_and_label(
    status: str, item_status: str, label: str
) -> None:
    (item,) = snapshot_items(review_item(status))

    assert item.status == item_status
    assert item.content["label"] == label
    assert item.content["kind"] != "unknown"


@pytest.mark.parametrize(
    ("action", "summary"),
    [
        (
            {"type": "execve", "source": "shell", "program": "/bin/rm", "argv": ["rm", "-f", "a"], "cwd": "/w"},
            "运行 rm -f a",
        ),
        (
            {"type": "applyPatch", "cwd": "/w", "files": ["/w/src/app.py"]},
            "编辑 app.py",
        ),
        (
            {"type": "applyPatch", "cwd": "/w", "files": ["/w/a.py", "/w/b.py"]},
            "编辑 2 个文件",
        ),
        (
            {"type": "networkAccess", "target": "https://pypi.org", "host": "pypi.org", "protocol": "https", "port": 443},
            "访问网络 https://pypi.org",
        ),
        (
            {"type": "mcpToolCall", "server": "github", "toolName": "create_issue", "connectorName": "GitHub"},
            "调用 MCP 工具 create_issue（GitHub）",
        ),
        (
            {"type": "writeStdin", "approvalId": "a", "processId": "42", "stdin": "y\n", "cwd": "/w"},
            "向进程 42 发送输入",
        ),
        (
            {"type": "requestPermissions", "reason": "需要联网安装依赖", "permissions": {}},
            "申请权限：需要联网安装依赖",
        ),
    ],
)
def test_review_label_summarizes_each_action_type(
    action: dict[str, Any], summary: str
) -> None:
    (item,) = snapshot_items(review_item("approved", action=action))

    assert item.content["label"] == f"自动审查已批准：{summary}"


def test_review_without_action_still_has_context() -> None:
    raw = review_item("approved")
    raw.pop("action")
    (item,) = snapshot_items(raw)

    assert item.content["label"] == "自动审查已批准"
    assert item.content["kind"] == "system"


def test_live_review_updates_the_same_marker_in_place() -> None:
    accumulator = CodexTimelineAccumulator()

    started = accumulator.item_from_notification(
        session_id="sess",
        external_session_id=THREAD,
        method="item/started",
        params={"threadId": THREAD, "turnId": TURN, "item": review_item("inProgress")},
    )
    completed = accumulator.item_from_notification(
        session_id="sess",
        external_session_id=THREAD,
        method="item/completed",
        params={
            "threadId": THREAD,
            "turnId": TURN,
            "item": review_item("approved", riskLevel="low", rationale="Only removes build output."),
        },
    )

    assert started is not None and completed is not None
    # Live updates and the later history replay land on the same Timeline item.
    (replayed,) = snapshot_items(review_item("approved"))
    assert started.id == completed.id == replayed.id
    assert (started.type, started.status) == ("marker", "running")
    assert started.content["label"] == "自动审查中：运行 rm -rf build"
    assert (completed.type, completed.status) == ("marker", "done")
    assert completed.content["label"] == "自动审查已批准：运行 rm -rf build"
    assert completed.content["text"] == "Only removes build output."
    assert completed.content["severity"] == "info"


def test_raw_content_accepts_app_server_nested_review() -> None:
    content = timeline_item_content(
        {
            "type": "automaticApprovalReview",
            "reviewId": "review-2",
            "action": {"type": "networkAccess", "target": "example.com", "host": "example.com"},
            "review": {"status": "timedOut", "riskLevel": None, "rationale": None},
        }
    )

    assert content["label"] == "自动审查超时：访问网络 example.com"
    assert content["review"] == {"status": "timedOut"}
