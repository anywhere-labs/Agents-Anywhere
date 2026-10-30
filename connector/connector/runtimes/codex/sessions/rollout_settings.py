"""Read a Codex thread's effective permission settings from its rollout file.

``thread/read`` omits approval and sandbox settings, and ``thread/resume`` would
take the thread's writer lock away from Codex Desktop. Codex appends the
settings it applies to the rollout (``turn_context`` at each turn,
``thread_settings_applied`` whenever settings change), so a state read takes the
newest of those records instead.
"""

from __future__ import annotations

import json
import os
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

# Settings records sit within a few KiB of the end in practice; the bound keeps
# a pathological rollout from turning a state read into a full file scan.
MAX_SCAN_BYTES = 1024 * 1024
_CHUNK_BYTES = 64 * 1024
_MARKERS = (b'"turn_context"', b'"thread_settings_applied"')
_PROFILE_SANDBOXES = {
    ":danger-full-access": "danger-full-access",
    ":workspace": "workspace-write",
    ":read-only": "read-only",
}
_POLICY_SANDBOXES = {
    "danger-full-access": "danger-full-access",
    "dangerFullAccess": "danger-full-access",
    "workspace-write": "workspace-write",
    "workspaceWrite": "workspace-write",
    "read-only": "read-only",
    "readOnly": "read-only",
}


def rollout_permission_settings(
    path: str | os.PathLike[str] | None,
    *,
    max_bytes: int = MAX_SCAN_BYTES,
) -> dict[str, Any]:
    """Return ``approvalPolicy``/``approvalsReviewer``/``sandbox`` or ``{}``.

    An empty result means unknown; callers must not substitute a default.
    """

    if not path:
        return {}
    try:
        for line in _lines_from_end(Path(path), max_bytes):
            if not any(marker in line for marker in _MARKERS):
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue  # a line Codex is still appending
            settings = _permission_settings(record)
            if settings is not None:
                return settings
    except OSError:
        return {}
    return {}


def _permission_settings(record: Any) -> dict[str, Any] | None:
    if not isinstance(record, Mapping):
        return None
    payload = record.get("payload")
    if not isinstance(payload, Mapping):
        return None
    if record.get("type") == "turn_context":
        source: Mapping[str, Any] = payload
        sandbox = _policy_sandbox(payload.get("sandbox_policy"))
    elif record.get("type") == "event_msg" and payload.get("type") == "thread_settings_applied":
        settings = payload.get("thread_settings")
        if not isinstance(settings, Mapping):
            return None
        source = settings
        sandbox = _profile_sandbox(settings)
    else:
        return None
    result: dict[str, Any] = {}
    for key, name in (("approval_policy", "approvalPolicy"), ("approvals_reviewer", "approvalsReviewer")):
        value = source.get(key)
        if isinstance(value, str) and value:
            result[name] = value
    if sandbox is not None:
        result["sandbox"] = sandbox
    return result or None


def _policy_sandbox(policy: Any) -> str | None:
    kind = policy.get("type") if isinstance(policy, Mapping) else policy
    return _POLICY_SANDBOXES.get(kind) if isinstance(kind, str) else None


def _profile_sandbox(settings: Mapping[str, Any]) -> str | None:
    active = settings.get("active_permission_profile")
    if isinstance(active, Mapping) and active.get("id") in _PROFILE_SANDBOXES:
        return _PROFILE_SANDBOXES[active["id"]]
    # Settings applied without a named profile carry only the resolved one.
    profile = settings.get("permission_profile")
    if not isinstance(profile, Mapping):
        return None
    if profile.get("type") == "disabled":
        return "danger-full-access"
    file_system = profile.get("file_system")
    if profile.get("type") != "managed" or not isinstance(file_system, Mapping):
        return None
    if file_system.get("type") != "restricted" or not isinstance(file_system.get("entries"), list):
        return None
    writable = any(
        isinstance(entry, Mapping) and entry.get("access") == "write"
        for entry in file_system["entries"]
    )
    return "workspace-write" if writable else "read-only"


def _lines_from_end(path: Path, max_bytes: int) -> Iterator[bytes]:
    """Yield complete lines from the end of ``path``, newest first."""

    with path.open("rb") as file:
        end = file.seek(0, os.SEEK_END)
        stop = max(0, end - max_bytes)
        position = end
        remainder = b""
        while position > stop:
            size = min(_CHUNK_BYTES, position - stop)
            position -= size
            file.seek(position)
            lines = (file.read(size) + remainder).split(b"\n")
            # The first piece may continue in the previous chunk.
            remainder = lines[0]
            for line in reversed(lines[1:]):
                if line.strip():
                    yield line
        if position == 0 and remainder.strip():
            yield remainder
