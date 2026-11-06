from __future__ import annotations

import asyncio
import errno
from pathlib import Path
from typing import Any

from connector.runtime_protocol import (
    RuntimeCapabilitySet,
    RuntimeConfig,
    RuntimeHostClient,
)
from connector.runtimes.claude import archive as claude_archive
from connector.runtimes.claude.archive import claude_config_root
from connector.runtimes.claude.runtime import ClaudeRuntime

SESSION_ID = "4f0d7d0c-4a16-4a45-9c5f-1e6041a7be11"
SLUG = "-home-user-project"


class _RecordingHost(RuntimeHostClient):
    def __init__(self) -> None:
        self.state_updates: list[dict[str, Any]] = []
        self.capability_updates: list[RuntimeCapabilitySet] = []

    @property
    def connector_id(self) -> str:
        return "conn_test"

    async def session_state_update(
        self,
        session_id: str,
        runtime: str,
        status: str | None = None,
        selections: dict[str, str | None] | None = None,
        external_session_id: str | None = None,
        status_reason: str | None = None,
        error: dict[str, Any] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        self.state_updates.append(
            {
                "session_id": session_id,
                "status": status,
                "external_session_id": external_session_id,
            }
        )

    async def session_capabilities_update(
        self,
        capabilities: RuntimeCapabilitySet,
    ) -> None:
        self.capability_updates.append(capabilities)


def _config(config_dir: Path | None) -> RuntimeConfig:
    environment: dict[str, str] = {}
    if config_dir is not None:
        environment["CLAUDE_CONFIG_DIR"] = str(config_dir)
    return RuntimeConfig(
        runtime="claude",
        revision=1,
        values={"environment": environment},
    )


def _runtime(config_dir: Path | None) -> ClaudeRuntime:
    return ClaudeRuntime(config=_config(config_dir), host=_RecordingHost())


def _write_transcript(
    config_dir: Path,
    session_id: str = SESSION_ID,
    slug: str = SLUG,
    *,
    archived: bool = False,
) -> Path:
    directory = config_dir / ("projects-archived" if archived else "projects") / slug
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{session_id}.jsonl"
    path.write_text('{"type":"summary"}\n', encoding="utf-8")
    return path


def test_claude_config_root_prefers_runtime_environment(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    from_runtime = tmp_path / "runtime-claude"
    from_process = tmp_path / "process-claude"
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(from_process))

    assert claude_config_root(_config(from_runtime)) == from_runtime
    assert claude_config_root(_config(None)) == from_process


def test_claude_archive_moves_transcript_and_restores_it(tmp_path: Path) -> None:
    async def run() -> None:
        source = _write_transcript(tmp_path)
        runtime = _runtime(tmp_path)

        archived = await runtime.update_session_archive(
            "sess_1",
            external_session_id=SESSION_ID,
            archived=True,
        )

        archived_path = tmp_path / "projects-archived" / SLUG / source.name
        assert archived == {
            "sessionId": "sess_1",
            "externalSessionId": SESSION_ID,
            "archived": True,
            "native": False,
            "supported": True,
            "status": "archived",
            "reason": None,
        }
        assert not source.exists()
        assert archived_path.read_text(encoding="utf-8") == '{"type":"summary"}\n'

        restored = await runtime.update_session_archive(
            "sess_1",
            external_session_id=SESSION_ID,
            archived=False,
        )

        assert restored["status"] == "restored"
        assert restored["supported"] is True
        assert source.exists()
        assert not archived_path.exists()

    asyncio.run(run())


def test_claude_archive_uses_process_config_dir_when_runtime_has_none(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    async def run() -> None:
        source = _write_transcript(tmp_path)
        monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
        runtime = _runtime(None)

        result = await runtime.update_session_archive(
            "sess_1",
            external_session_id=SESSION_ID,
            archived=True,
        )

        assert result["status"] == "archived"
        assert not source.exists()
        assert (
            tmp_path / "projects-archived" / SLUG / source.name
        ).is_file()

    asyncio.run(run())


def test_claude_archive_rejects_unsafe_session_ids(tmp_path: Path) -> None:
    async def run() -> None:
        runtime = _runtime(tmp_path)

        result = await runtime.update_session_archive(
            "sess_1",
            external_session_id="../../outside",
            archived=True,
        )

        assert result["supported"] is False
        assert result["status"] == "unsupported"
        assert result["reason"] == "invalid_session_id"
        assert list(tmp_path.rglob("*.jsonl")) == []

    asyncio.run(run())


def test_claude_archive_reports_missing_transcript(tmp_path: Path) -> None:
    async def run() -> None:
        result = await _runtime(tmp_path).update_session_archive(
            "sess_1",
            external_session_id=SESSION_ID,
            archived=True,
        )

        assert result["supported"] is False
        assert result["status"] == "unsupported"
        assert result["reason"] == "transcript_not_found"

    asyncio.run(run())


def test_claude_archive_reports_unknown_native_session(tmp_path: Path) -> None:
    async def run() -> None:
        result = await _runtime(tmp_path).update_session_archive(
            "sess_1",
            archived=True,
        )

        assert result["externalSessionId"] is None
        assert result["supported"] is False
        assert result["status"] == "unsupported"
        assert result["reason"] == "native_session_unknown"

    asyncio.run(run())


def test_claude_archive_skips_when_destination_exists(tmp_path: Path) -> None:
    async def run() -> None:
        source = _write_transcript(tmp_path)
        archived = _write_transcript(tmp_path, archived=True)

        result = await _runtime(tmp_path).update_session_archive(
            "sess_1",
            external_session_id=SESSION_ID,
            archived=True,
        )

        assert result["supported"] is True
        assert result["status"] == "skipped"
        assert result["reason"] == "destination_exists"
        assert source.is_file()
        assert archived.is_file()

    asyncio.run(run())


def test_claude_archive_is_idempotent(tmp_path: Path) -> None:
    async def run() -> None:
        _write_transcript(tmp_path)
        runtime = _runtime(tmp_path)

        first = await runtime.update_session_archive(
            "sess_1", external_session_id=SESSION_ID, archived=True
        )
        second = await runtime.update_session_archive(
            "sess_1", external_session_id=SESSION_ID, archived=True
        )
        third = await runtime.update_session_archive(
            "sess_1", external_session_id=SESSION_ID, archived=False
        )
        fourth = await runtime.update_session_archive(
            "sess_1", external_session_id=SESSION_ID, archived=False
        )

        assert first["status"] == "archived"
        assert second["status"] == "skipped"
        assert second["reason"] == "already_archived"
        assert third["status"] == "restored"
        assert fourth["status"] == "skipped"
        assert fourth["reason"] == "already_restored"

    asyncio.run(run())


def test_claude_archive_skips_running_session(tmp_path: Path) -> None:
    async def run() -> None:
        source = _write_transcript(tmp_path)
        runtime = _runtime(tmp_path)
        await runtime._session_states.update("sess_1", SESSION_ID, "running")

        result = await runtime.update_session_archive(
            "sess_1",
            external_session_id=SESSION_ID,
            archived=True,
        )

        assert result["supported"] is True
        assert result["status"] == "skipped"
        assert result["reason"] == "session_running"
        assert source.is_file()

    asyncio.run(run())


def test_claude_archive_reports_io_failure(tmp_path: Path, monkeypatch: Any) -> None:
    async def run() -> None:
        source = _write_transcript(tmp_path)

        def fail_move(source_path: str, target_path: str) -> None:
            _ = source_path, target_path
            raise OSError(errno.EACCES, "permission denied")

        monkeypatch.setattr(claude_archive.shutil, "move", fail_move)

        result = await _runtime(tmp_path).update_session_archive(
            "sess_1",
            external_session_id=SESSION_ID,
            archived=True,
        )

        assert result["supported"] is True
        assert result["status"] == "failed"
        assert result["reason"] == "permission_denied"
        assert source.is_file()

    asyncio.run(run())
