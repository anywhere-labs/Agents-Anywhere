"""Method version table of the Codex IPC owner/follower protocol.

Each request and broadcast carries an integer ``version``. Receivers compare it
with the version they implement and silently drop broadcasts or answer
``request-version-mismatch`` for requests when they differ, so this table must
be kept in sync with the installed Codex extension / desktop build. Methods not
listed here are version ``0``.

Extracted from Codex extension ``openai.chatgpt`` 26.1007.21434 (identical in
the desktop app 26.1007.21159).
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

METHOD_VERSIONS: Mapping[str, int] = {
    "thread-stream-state-changed": 11,
    "thread-stream-following-changed": 1,
    "thread-stream-following-status-requested": 1,
    "ipc-connection-reset": 1,
    "thread-read-state-changed": 3,
    "thread-archived": 2,
    "thread-unarchived": 1,
    "thread-owner-discovery": 1,
    "thread-follower-start-turn": 2,
    "thread-follower-load-complete-history": 1,
    "thread-follower-compact-thread": 1,
    "thread-follower-steer-turn": 1,
    "thread-follower-interrupt-turn": 4,
    "thread-follower-update-thread-settings": 2,
    "thread-follower-update-daybreak": 1,
    "thread-follower-read-model-settings": 1,
    "thread-follower-edit-last-user-turn": 2,
    "thread-follower-command-approval-decision": 1,
    "thread-follower-file-approval-decision": 1,
    "thread-follower-permissions-request-approval-response": 1,
    "thread-follower-submit-user-input": 1,
    "thread-follower-submit-mcp-server-elicitation-response": 1,
    "thread-follower-set-queued-follow-ups-state": 1,
    "thread-follower-remove-queued-message": 1,
    "thread-follower-clear-queued-messages": 1,
    "thread-queued-followups-changed": 2,
}

THREAD_FOLLOWER_PREFIX = "thread-follower-"
_INTERRUPT_TURN = "thread-follower-interrupt-turn"
_INTERRUPT_TURN_LEGACY_VERSION = 3


def version_for(
    method: str,
    *,
    params: Mapping[str, Any] | None = None,
    host_id: str | None = None,
) -> int:
    """Return the version to stamp on an outgoing request or broadcast.

    Follower requests addressed to a remote host (``host_id`` set) use the table
    version plus one. ``thread-follower-interrupt-turn`` without an
    ``expectedTurnId`` keeps the legacy version 3.
    """

    base = METHOD_VERSIONS.get(method, 0)
    if host_id is not None and method.startswith(THREAD_FOLLOWER_PREFIX):
        return base + 1
    if (
        method == _INTERRUPT_TURN
        and params is not None
        and params.get("expectedTurnId") is None
    ):
        return _INTERRUPT_TURN_LEGACY_VERSION
    return base


def accepts_version(method: str, version: int, host_id: str | None = None) -> bool:
    """Whether an incoming message with ``version`` matches our implementation."""

    if version == version_for(method, host_id=host_id):
        return True
    return (
        host_id is None
        and method == _INTERRUPT_TURN
        and version == _INTERRUPT_TURN_LEGACY_VERSION
    )
