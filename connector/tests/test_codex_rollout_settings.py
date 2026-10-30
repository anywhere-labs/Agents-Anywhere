from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.sessions import rollout_settings
from connector.runtimes.codex.sessions.rollout_settings import rollout_permission_settings
from tests.test_codex_runtime import FakeCodexClient, FakeHost, _config


class ResumableCodexClient(FakeCodexClient):
    """Exposes resume so that a state read which resumes would be recorded."""

    async def resume_thread_state(self, thread_id: str) -> dict[str, Any]:
        self.record_request("thread/resume", {"threadId": thread_id})
        return {"approvalPolicy": "on-request", "sandbox": "workspace-write"}

    def thread_loaded(self, thread_id: str) -> bool:
        return False

ROLLOUT_TOP = {"timestamp": "2026-10-26T07:50:24.066Z", "type": "session_meta", "payload": {"id": "thread_1"}}


def _turn_context(approval: str, sandbox: str, reviewer: str = "user") -> dict[str, Any]:
    return {
        "type": "turn_context",
        "payload": {"approval_policy": approval, "approvals_reviewer": reviewer, "sandbox_policy": {"type": sandbox}},
    }


def _settings_applied(approval: str, *, profile: dict[str, Any], active: str | None = None) -> dict[str, Any]:
    settings: dict[str, Any] = {"approval_policy": approval, "approvals_reviewer": "user", "permission_profile": profile}
    if active is not None:
        settings["active_permission_profile"] = {"id": active}
    return {"type": "event_msg", "payload": {"type": "thread_settings_applied", "thread_settings": settings}}


DISABLED = {"type": "disabled"}
WORKSPACE = {
    "type": "managed",
    "file_system": {
        "type": "restricted",
        "entries": [
            {"path": {"type": "special", "value": {"kind": "root"}}, "access": "read"},
            {"path": {"type": "path", "path": "/work"}, "access": "write"},
        ],
    },
}


def _write(path: Path, *records: dict[str, Any], tail: str = "") -> Path:
    lines = [json.dumps(record) for record in (ROLLOUT_TOP, *records)]
    path.write_text("\n".join(lines) + "\n" + tail, encoding="utf-8")
    return path


def test_newest_settings_record_wins(tmp_path: Path) -> None:
    rollout = _write(
        tmp_path / "rollout.jsonl",
        _turn_context("on-request", "workspace-write"),
        {"type": "response_item", "payload": {"type": "message", "role": "user"}},
        _settings_applied("never", profile=DISABLED),
    )

    assert rollout_permission_settings(rollout) == {
        "approvalPolicy": "never",
        "approvalsReviewer": "user",
        "sandbox": "danger-full-access",
    }


def test_turn_context_after_settings_change_is_used(tmp_path: Path) -> None:
    rollout = _write(
        tmp_path / "rollout.jsonl",
        _settings_applied("never", profile=DISABLED),
        _turn_context("on-request", "workspace-write", reviewer="auto_review"),
    )

    assert rollout_permission_settings(rollout) == {
        "approvalPolicy": "on-request",
        "approvalsReviewer": "auto_review",
        "sandbox": "workspace-write",
    }


def test_named_and_resolved_profiles_map_to_sandbox_modes(tmp_path: Path) -> None:
    named = _write(tmp_path / "named.jsonl", _settings_applied("on-request", profile=WORKSPACE, active=":workspace"))
    resolved = _write(tmp_path / "resolved.jsonl", _settings_applied("on-request", profile=WORKSPACE))
    read_only = _write(
        tmp_path / "read_only.jsonl",
        _settings_applied(
            "on-request",
            profile={"type": "managed", "file_system": {"type": "restricted", "entries": [{"access": "read"}]}},
        ),
    )

    assert rollout_permission_settings(named)["sandbox"] == "workspace-write"
    assert rollout_permission_settings(resolved)["sandbox"] == "workspace-write"
    assert rollout_permission_settings(read_only)["sandbox"] == "read-only"


def test_line_being_appended_is_skipped(tmp_path: Path) -> None:
    rollout = _write(
        tmp_path / "rollout.jsonl",
        _turn_context("on-request", "workspace-write"),
        tail='{"type": "event_msg", "payload": {"type": "thread_settings_applied", "thread_set',
    )

    assert rollout_permission_settings(rollout)["approvalPolicy"] == "on-request"


def test_unknown_when_missing_or_beyond_the_scan_window(tmp_path: Path) -> None:
    rollout = _write(
        tmp_path / "rollout.jsonl",
        _turn_context("never", "danger-full-access"),
        *({"type": "response_item", "payload": {"type": "message", "text": "x" * 200}} for _ in range(20)),
    )

    assert rollout_permission_settings(None) == {}
    assert rollout_permission_settings(tmp_path / "missing.jsonl") == {}
    assert rollout_permission_settings(_write(tmp_path / "empty.jsonl")) == {}
    assert rollout_permission_settings(rollout, max_bytes=1024) == {}
    assert rollout_permission_settings(rollout)["sandbox"] == "danger-full-access"


def test_lines_split_across_chunks_are_reassembled(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rollout_settings, "_CHUNK_BYTES", 7)
    rollout = _write(
        tmp_path / "rollout.jsonl",
        _settings_applied("never", profile=DISABLED),
        {"type": "response_item", "payload": {"type": "message", "text": "after"}},
    )

    assert rollout_permission_settings(rollout)["sandbox"] == "danger-full-access"


def test_session_state_reads_permission_from_rollout_without_resuming(tmp_path: Path) -> None:
    asyncio.run(_test_session_state_reads_permission_from_rollout_without_resuming(tmp_path))


async def _test_session_state_reads_permission_from_rollout_without_resuming(tmp_path: Path) -> None:
    rollout = _write(tmp_path / "rollout.jsonl", _settings_applied("never", profile=DISABLED, active=":danger-full-access"))
    client = ResumableCodexClient()
    client.results["thread/read"] = {"thread": {"id": "thread_1", "path": str(rollout), "items": []}}
    client.results["thread/resume"] = {}
    runtime = CodexRuntime(config=_config(), host=FakeHost(), client=client)
    full_access = (await runtime.list_permission_catalog(query="full")).permissions[0].selection_id

    state = await runtime.get_session_state("sess_1", external_session_id="thread_1")

    assert state is not None
    assert state.selections == {"permission": full_access}
    methods = [method for method, _params in client.requests]
    assert "thread/read" in methods
    assert "thread/resume" not in methods, "a state read must not take the thread's writer lock"
