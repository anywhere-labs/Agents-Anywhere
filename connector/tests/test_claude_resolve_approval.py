from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from connector.claude.adapter import ClaudeAdapter, _PendingApproval, _SessionRuntime  # type: ignore[attr-defined]
from connector.claude.approval_parser import ApprovalChoice, DetectedApproval


class FakePty:
    def __init__(self):
        self._alive = True
        self.sent: list[bytes] = []

    def send(self, data):
        b = data.encode("utf-8") if isinstance(data, str) else data
        self.sent.append(b)

    def send_enter(self): self.sent.append(b"\r")
    def send_esc(self): self.sent.append(b"\x1b")
    def send_ctrl_c(self):
        self.sent.append(b"\x03")
        self._alive = False
    def isalive(self): return self._alive
    def terminate(self, *, force=False): self._alive = False


def _runtime_with_pending(approval_id: str = "appr_test") -> tuple[ClaudeAdapter, _SessionRuntime, FakePty]:
    adapter = ClaudeAdapter()
    pty = FakePty()
    runtime = _SessionRuntime(
        claude_uuid="u-1", session_id="sess_x", cwd="/tmp", pty=pty,  # type: ignore[arg-type]
    )
    adapter._sessions["sess_x"] = runtime
    detected = DetectedApproval(
        kind="command",
        title="Bash command",
        description="rm -rf /tmp/foo",
        question="Do you want to proceed?",
        choices=[
            ApprovalChoice(key="1", label="Yes", action="approve"),
            ApprovalChoice(key="2", label="Yes, allow all", action="approve_for_session"),
            ApprovalChoice(key="3", label="No", action="reject"),
            ApprovalChoice(key="esc", label="Cancel", action="cancel"),
        ],
        focused_key="1",
        fingerprint="abc123",
    )
    runtime.pending_approvals[approval_id] = _PendingApproval(
        approval_id=approval_id, detected=detected, turn_id=None,
    )
    return adapter, runtime, pty


def test_approved_sends_1_enter() -> None:
    adapter, runtime, pty = _runtime_with_pending()
    r = asyncio.run(adapter.resolve_approval({
        "sessionId": "sess_x", "approvalId": "appr_test", "status": "approved",
    }))
    assert r["resolved"] is True
    assert r["key"] == "1"
    assert pty.sent == [b"1", b"\r"]
    assert "appr_test" not in runtime.pending_approvals


def test_approved_for_session_sends_2_enter() -> None:
    adapter, runtime, pty = _runtime_with_pending()
    r = asyncio.run(adapter.resolve_approval({
        "sessionId": "sess_x", "approvalId": "appr_test", "status": "approved_for_session",
    }))
    assert r["resolved"] is True
    assert r["key"] == "2"
    assert pty.sent == [b"2", b"\r"]


def test_rejected_sends_3_enter() -> None:
    adapter, runtime, pty = _runtime_with_pending()
    r = asyncio.run(adapter.resolve_approval({
        "sessionId": "sess_x", "approvalId": "appr_test", "status": "rejected",
    }))
    assert r["resolved"] is True
    assert r["key"] == "3"
    assert pty.sent == [b"3", b"\r"]


def test_cancelled_sends_esc_only() -> None:
    adapter, runtime, pty = _runtime_with_pending()
    r = asyncio.run(adapter.resolve_approval({
        "sessionId": "sess_x", "approvalId": "appr_test", "status": "cancelled",
    }))
    assert r["resolved"] is True
    assert r["key"] == "esc"
    assert pty.sent == [b"\x1b"]


def test_unknown_approval_returns_false() -> None:
    adapter, runtime, _ = _runtime_with_pending()
    r = asyncio.run(adapter.resolve_approval({
        "sessionId": "sess_x", "approvalId": "appr_unknown", "status": "approved",
    }))
    assert r["resolved"] is False
    assert "not pending" in r["reason"]


def test_unknown_session_returns_false() -> None:
    adapter = ClaudeAdapter()
    r = asyncio.run(adapter.resolve_approval({
        "sessionId": "sess_y", "approvalId": "appr_x", "status": "approved",
    }))
    assert r["resolved"] is False


def test_dead_pty_returns_false() -> None:
    adapter, runtime, pty = _runtime_with_pending()
    pty._alive = False
    r = asyncio.run(adapter.resolve_approval({
        "sessionId": "sess_x", "approvalId": "appr_test", "status": "approved",
    }))
    assert r["resolved"] is False


def test_approve_for_session_falls_back_to_approve_when_no_option_2() -> None:
    """Some single-shot prompts don't offer 'Yes, allow all'. The
    backend may still send approved_for_session; we degrade gracefully."""
    adapter, runtime, pty = _runtime_with_pending()
    # Mutate the pending approval to have only options 1 and 3.
    pending = runtime.pending_approvals["appr_test"]
    pending.detected.choices = [
        ApprovalChoice(key="1", label="Yes", action="approve"),
        ApprovalChoice(key="3", label="No", action="reject"),
        ApprovalChoice(key="esc", label="Cancel", action="cancel"),
    ]
    r = asyncio.run(adapter.resolve_approval({
        "sessionId": "sess_x", "approvalId": "appr_test", "status": "approved_for_session",
    }))
    assert r["resolved"] is True
    assert r["key"] == "1"


def test_handle_detected_dialog_pushes_notification(tmp_path: Path) -> None:
    """When the approval monitor fires, the adapter should mint an
    approval id, remember the dialog, and push approval.requested."""
    notifs: list[tuple[str, dict[str, Any]]] = []

    async def sink(method, params):
        notifs.append((method, params))

    adapter = ClaudeAdapter(notification_sink=sink, projects_dir=tmp_path / "projects")
    runtime = _SessionRuntime(claude_uuid="u-1", session_id="sess_x", cwd="/tmp")
    adapter._sessions["sess_x"] = runtime
    detected = DetectedApproval(
        kind="command",
        title="Bash command",
        description="ls -la /etc",
        question="Do you want to proceed?",
        choices=[
            ApprovalChoice(key="1", label="Yes", action="approve"),
            ApprovalChoice(key="3", label="No", action="reject"),
            ApprovalChoice(key="esc", label="Cancel", action="cancel"),
        ],
        focused_key="1",
        fingerprint="finger1",
    )

    asyncio.run(adapter._handle_detected_dialog(runtime, detected))

    assert len(notifs) == 1
    method, params = notifs[0]
    assert method == "approval.requested"
    assert params["sessionId"] == "sess_x"
    assert params["kind"] == "command"
    assert params["title"] == "Bash command"
    assert params["source"]["runtime"] == "claude"
    assert params["source"]["method"] == "tui_dialog"
    assert params["status"] == "pending"
    # The exact fingerprint is encoded in the approval id.
    assert params["id"].endswith("finger1")
    # Choice list is preserved in payload.
    payload_keys = [c["key"] for c in params["payload"]["choices"]]
    assert payload_keys == ["1", "3", "esc"]
    # Pending tracker now holds it.
    assert params["id"] in runtime.pending_approvals


def test_handle_detected_dialog_dedupes_same_fingerprint(tmp_path: Path) -> None:
    notifs: list[tuple[str, dict[str, Any]]] = []
    async def sink(method, params): notifs.append((method, params))
    adapter = ClaudeAdapter(notification_sink=sink, projects_dir=tmp_path / "projects")
    runtime = _SessionRuntime(claude_uuid="u-1", session_id="sess_x", cwd="/tmp")
    adapter._sessions["sess_x"] = runtime
    detected = DetectedApproval(
        kind="command", title="Bash", description="ls", question="?",
        choices=[ApprovalChoice(key="1", label="Yes", action="approve")],
        focused_key="1", fingerprint="dupe",
    )
    asyncio.run(adapter._handle_detected_dialog(runtime, detected))
    asyncio.run(adapter._handle_detected_dialog(runtime, detected))
    assert len(notifs) == 1
