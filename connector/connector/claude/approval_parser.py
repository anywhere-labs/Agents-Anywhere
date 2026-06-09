"""Claude TUI approval-dialog parser.

When `claude` is launched outside `bypassPermissions` mode and the model
wants to do something dangerous (Bash command, file Edit/Write, etc.) it
pops up a confirmation modal in the terminal:

     Bash command

       rm -rf /tmp/some-dir
       Remove the specified directory

     Do you want to proceed?
     ❯ 1. Yes
       2. Yes, and always allow access to tmp/ from this project
       3. No

     Esc to cancel · Tab to amend · ctrl+e to explain

This data never reaches the JSONL — it lives only on the terminal. We
feed the PTY byte stream through `pyte` to render it into a virtual
screen and then scan that screen for anchor text. When a dialog appears,
we emit an `approval.requested` notification; the backend stores it,
the phone shows a Yes/No modal, and the user's choice comes back through
`adapter.resolve_approval` which sends the matching keystroke.

Research doc §5 has the full reverse-engineering trail.
"""

from __future__ import annotations

import hashlib
import re
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import pyte
from loguru import logger


# ─── Anchors (research doc §5.2 + §10.1) ────────────────────────────────────

# Body sentinels — at least one must be present for a dialog to count.
_BODY_SENTINELS = (
    "Do you want to proceed?",
    "Do you want to make this edit to",
    "Do you want to make this change to",  # observed variant
)

# Footer sentinel — closes the dialog block.
_FOOTER_SENTINEL = "Esc to cancel"

# Header — `^ <Tool> ...` on the first non-blank visible line above the body.
_HEADER_RE = re.compile(r"^\s*([A-Z][A-Za-z]+(?:\s+[a-z]+)?)\s*$")

# Option lines — `❯ 1. ...` (cursor) or ` 2. ...` (not selected).
_OPTION_RE = re.compile(r"^\s*([❯ ])\s*(\d+)\.\s*(.*)$")


# ─── Output shape ────────────────────────────────────────────────────────────


@dataclass(slots=True)
class ApprovalChoice:
    key: str          # "1", "2", "3", "esc"
    label: str        # what the user sees in the TUI
    action: str       # "approve" | "approve_for_session" | "reject" | "cancel"


@dataclass(slots=True)
class DetectedApproval:
    kind: str                       # "command" | "file_change" | "tool_call"
    title: str                      # header line, e.g. "Bash command"
    description: str                # body lines between header and "Do you want..."
    question: str                   # the "Do you want to proceed?" line
    choices: list[ApprovalChoice]
    focused_key: str | None         # which choice the cursor is on, if any
    fingerprint: str                # stable hash so we don't re-emit the same dialog


# ─── Screen parser ───────────────────────────────────────────────────────────


def parse_screen(lines: list[str]) -> DetectedApproval | None:
    """Scan a list of rendered screen lines for an approval dialog.

    Returns `None` when no dialog is present. The decision is purely
    text-based, so any test that builds the same shape works without a
    real PTY.
    """
    # 1. Locate body & footer.
    body_idx = _find_first(lines, _BODY_SENTINELS)
    if body_idx is None:
        return None
    footer_idx = None
    for i in range(body_idx + 1, len(lines)):
        if _FOOTER_SENTINEL in lines[i]:
            footer_idx = i
            break
    if footer_idx is None:
        # Dialog is mid-render. Wait for next tick.
        return None

    # 2. Header: walk upwards from body to the first single-token line we see.
    header_idx = None
    for i in range(body_idx - 1, -1, -1):
        stripped = lines[i].strip()
        if not stripped:
            continue
        if _HEADER_RE.match(stripped):
            header_idx = i
            break
    title = lines[header_idx].strip() if header_idx is not None else ""
    kind = _kind_for_title(title)

    # 3. Description: everything between header (exclusive) and the body
    # sentinel (exclusive), trimmed.
    description_lines: list[str] = []
    start = header_idx + 1 if header_idx is not None else 0
    for i in range(start, body_idx):
        text = lines[i].rstrip()
        if text.strip():
            description_lines.append(text)
    description = "\n".join(description_lines).strip()

    # 4. Choices: option lines between body sentinel and footer.
    choices: list[ApprovalChoice] = []
    focused: str | None = None
    for i in range(body_idx + 1, footer_idx):
        match = _OPTION_RE.match(lines[i])
        if not match:
            continue
        cursor, num, label_raw = match.groups()
        label = label_raw.strip()
        action = _action_for_option(num, label)
        choices.append(ApprovalChoice(key=num, label=label, action=action))
        if cursor == "❯":
            focused = num
    # ESC is implicit; surface it as a cancel choice so resolve_approval
    # has a canonical action -> keystroke mapping.
    choices.append(ApprovalChoice(key="esc", label="Cancel", action="cancel"))

    fingerprint = _fingerprint(title, description, [c.key + ":" + c.label for c in choices])
    return DetectedApproval(
        kind=kind,
        title=title,
        description=description,
        question=lines[body_idx].strip(),
        choices=choices,
        focused_key=focused,
        fingerprint=fingerprint,
    )


def _find_first(lines: list[str], needles: tuple[str, ...]) -> int | None:
    for i, line in enumerate(lines):
        for needle in needles:
            if needle in line:
                return i
    return None


def _kind_for_title(title: str) -> str:
    lower = title.lower()
    if "command" in lower:
        return "command"
    if "file" in lower or "edit" in lower or "write" in lower:
        return "file_change"
    return "tool_call"


def _action_for_option(num: str, label: str) -> str:
    lower = label.lower()
    if num == "3" or lower.startswith("no"):
        return "reject"
    if "always" in lower or "allow" in lower:
        return "approve_for_session"
    return "approve"


def _fingerprint(title: str, description: str, choice_keys: list[str]) -> str:
    blob = "|".join([title, description, ";".join(choice_keys)])
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


# ─── Live monitor: feed PTY bytes into pyte, poll for dialogs ────────────────


_DialogCallback = Callable[[DetectedApproval], Any]


@dataclass(slots=True)
class ApprovalMonitor:
    """Background watcher that feeds PTY chunks into pyte and notifies
    `on_dialog` whenever a new approval dialog appears.

    Thread-safe: bytes can be pushed from any thread (we use a lock).
    The polling thread fires the callback on the main asyncio loop via
    a thread-safe queue — actually here we just call the callback in the
    poll thread, so the caller's `on_dialog` MUST be threadsafe (e.g. it
    runs `asyncio.run_coroutine_threadsafe` itself).
    """

    on_dialog: _DialogCallback
    rows: int = 50
    cols: int = 140
    poll_interval: float = 0.3
    _screen: pyte.Screen = field(init=False)
    _stream: pyte.Stream = field(init=False)
    _feed_lock: threading.Lock = field(init=False, default_factory=threading.Lock)
    _thread: threading.Thread | None = field(init=False, default=None)
    _stop: threading.Event = field(init=False, default_factory=threading.Event)
    _last_fingerprint: str | None = field(init=False, default=None)
    _last_lines: list[str] = field(init=False, default_factory=list)

    def __post_init__(self) -> None:
        self._screen = pyte.Screen(self.cols, self.rows)
        self._stream = pyte.Stream(self._screen)

    def feed(self, data: bytes) -> None:
        if not data:
            return
        try:
            text = data.decode("utf-8", errors="replace")
        except Exception:
            return
        with self._feed_lock:
            self._stream.feed(text)

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(
            target=self._loop, name="claude-approval-monitor", daemon=True
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
            self._thread = None

    def _loop(self) -> None:
        while not self._stop.is_set():
            try:
                with self._feed_lock:
                    lines = list(self._screen.display)
                self._last_lines = lines
                detected = parse_screen(lines)
                if detected is not None and detected.fingerprint != self._last_fingerprint:
                    self._last_fingerprint = detected.fingerprint
                    try:
                        self.on_dialog(detected)
                    except Exception:
                        logger.exception("approval on_dialog callback failed")
                elif detected is None and self._last_fingerprint is not None:
                    # Dialog cleared (Claude resumed after our keystroke).
                    self._last_fingerprint = None
            except Exception:
                logger.exception("approval monitor loop tick failed")
            time.sleep(self.poll_interval)

    def snapshot_screen(self) -> list[str]:
        """Latest rendered screen lines (for diagnostics / review)."""
        return list(self._last_lines)


__all__ = [
    "ApprovalChoice",
    "ApprovalMonitor",
    "DetectedApproval",
    "parse_screen",
]
