"""Parser tests use rendered screen lines directly — what pyte would
produce. The live monitor path (PTY bytes → pyte → callback) is covered
end-to-end in scripts/claude_approval_review.py."""

from __future__ import annotations

from connector.claude.approval_parser import (
    ApprovalMonitor,
    DetectedApproval,
    parse_screen,
)


# Bash command rejection — research doc §5.1, exact TUI text.
_BASH_SCREEN = [
    "",
    " Bash command",
    "",
    "   rm -rf /tmp/some-fake-dir-that-doesnt-exist",
    "   Remove the specified directory",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and always allow access to tmp/ from this project",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend · ctrl+e to explain",
    "",
]

# Edit dialog — research doc §10.1.
_EDIT_SCREEN = [
    "",
    " Edit file",
    " target.txt",
    "╌╌╌╌╌╌╌",
    " 1  original line 1",
    " 2 -original line 2",
    " 2 +modified by claude",
    " 3  original line 3",
    "╌╌╌╌╌╌╌",
    " Do you want to make this edit to target.txt?",
    " ❯ 1. Yes",
    "   2. Yes, allow all edits during this session (shift+tab)",
    "   3. No",
    " Esc to cancel · Tab to amend",
    "",
]


def test_bash_dialog_is_detected() -> None:
    d = parse_screen(_BASH_SCREEN)
    assert d is not None
    assert d.title == "Bash command"
    assert d.kind == "command"
    assert "rm -rf" in d.description
    assert d.question.startswith("Do you want to proceed")
    keys = [c.key for c in d.choices]
    assert keys == ["1", "2", "3", "esc"]
    actions = {c.key: c.action for c in d.choices}
    assert actions["1"] == "approve"
    assert actions["2"] == "approve_for_session"
    assert actions["3"] == "reject"
    assert actions["esc"] == "cancel"
    assert d.focused_key == "1"


def test_edit_dialog_is_detected() -> None:
    d = parse_screen(_EDIT_SCREEN)
    assert d is not None
    assert d.title == "Edit file"
    assert d.kind == "file_change"
    assert "modified by claude" in d.description
    assert "make this edit" in d.question
    keys = [c.key for c in d.choices]
    assert keys == ["1", "2", "3", "esc"]


def test_screen_without_dialog_returns_none() -> None:
    lines = [
        "",
        " Welcome to Claude Code",
        " Type your message and press Enter",
        "",
    ]
    assert parse_screen(lines) is None


def test_partial_dialog_returns_none() -> None:
    # Body sentinel present but footer not yet rendered.
    lines = [
        " Bash command",
        "   rm /tmp/x",
        " Do you want to proceed?",
        " ❯ 1. Yes",
        # No 'Esc to cancel' yet.
    ]
    assert parse_screen(lines) is None


def test_fingerprint_is_stable_across_identical_screens() -> None:
    a = parse_screen(_BASH_SCREEN)
    b = parse_screen(_BASH_SCREEN)
    assert a is not None and b is not None
    assert a.fingerprint == b.fingerprint


def test_fingerprint_differs_for_different_commands() -> None:
    a = parse_screen(_BASH_SCREEN)
    modified = list(_BASH_SCREEN)
    modified[3] = "   rm -rf /other/path"
    b = parse_screen(modified)
    assert a is not None and b is not None
    assert a.fingerprint != b.fingerprint


def test_monitor_emits_once_per_unique_dialog() -> None:
    """Feed the same dialog bytes twice; callback should fire once."""
    import time
    calls: list[DetectedApproval] = []

    monitor = ApprovalMonitor(on_dialog=lambda d: calls.append(d), poll_interval=0.05)
    # Build a fake byte stream that just spits out the dialog text and a
    # cursor-home so pyte renders it predictably.
    blob = "\x1b[2J\x1b[H" + "\r\n".join(_BASH_SCREEN)
    monitor.feed(blob.encode("utf-8"))
    monitor.start()
    try:
        # Wait for the poll thread to pick it up.
        deadline = time.time() + 2.0
        while time.time() < deadline and not calls:
            time.sleep(0.02)
        assert len(calls) == 1
        # Re-feeding the same screen state must NOT re-emit.
        monitor.feed(b"")  # no-op
        time.sleep(0.2)
        assert len(calls) == 1
    finally:
        monitor.stop()


def test_monitor_re_emits_after_screen_clears() -> None:
    """Dialog cleared (user resolved it) → next dialog must fire again."""
    import time
    calls: list[DetectedApproval] = []
    monitor = ApprovalMonitor(on_dialog=lambda d: calls.append(d), poll_interval=0.05)
    monitor.start()
    try:
        # First dialog.
        monitor.feed(("\x1b[2J\x1b[H" + "\r\n".join(_BASH_SCREEN)).encode("utf-8"))
        deadline = time.time() + 2.0
        while time.time() < deadline and not calls:
            time.sleep(0.02)
        assert len(calls) == 1

        # Clear the screen (simulating dialog dismissed).
        monitor.feed(b"\x1b[2J\x1b[H" + b"\r\n".join([b" Welcome back", b""]))
        time.sleep(0.2)

        # Second dialog with different content.
        modified = list(_BASH_SCREEN)
        modified[3] = "   rm -rf /other/path"
        monitor.feed(("\x1b[2J\x1b[H" + "\r\n".join(modified)).encode("utf-8"))
        deadline = time.time() + 2.0
        while time.time() < deadline and len(calls) < 2:
            time.sleep(0.02)
        assert len(calls) == 2
    finally:
        monitor.stop()
