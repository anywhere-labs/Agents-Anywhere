from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from connector import capabilities
from connector import launch
from connector.codex import rpc as codex_rpc


def _write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(0o755)


def test_claude_capability_checks_version_and_help_only(monkeypatch, tmp_path: Path) -> None:
    claude_bin = tmp_path / "claude"
    _write_executable(
        claude_bin,
        """#!/usr/bin/env sh
if [ "$1" = "--version" ]; then
  echo "2.1.159 (Claude Code)"
  exit 0
fi
if [ "$1" = "--help" ]; then
  echo "Usage: claude"
  exit 0
fi
exit 9
""",
    )
    monkeypatch.setenv("CLAUDE_BIN", str(claude_bin))
    monkeypatch.setattr(capabilities, "_list_claude_sdk_sessions", lambda: [object()])

    report, selected = asyncio.run(capabilities.discover_claude_capability())

    assert selected is not None
    assert selected.path == str(claude_bin)
    assert report["history"] == "ok"
    assert report["execution"] == "ok"
    assert report["historyCheck"]["source"] == "claude-agent-sdk"
    assert report["historyCheck"]["api"] == "list_sessions"
    assert report["historyCheck"]["sessionCount"] == 1
    assert report["selected"]["version"] == "2.1.159 (Claude Code)"


def test_codex_capability_tries_app_before_cli(monkeypatch, tmp_path: Path) -> None:
    old_cli = tmp_path / "old-codex"
    app = tmp_path / "Codex.app" / "Contents" / "Resources" / "codex"
    app.parent.mkdir(parents=True)
    _write_executable(old_cli, "#!/usr/bin/env sh\necho codex-cli 0.50.0\n")
    _write_executable(app, "#!/usr/bin/env sh\necho codex-cli 0.135.0-alpha.1\n")

    checked: list[str] = []

    async def fake_check(candidate: dict[str, str]) -> dict[str, Any]:
        checked.append(candidate["source"])
        if candidate["path"] == str(app):
            return {
                "source": "app",
                "path": str(app),
                "status": "ok",
                "version": "codex-cli 0.135.0-alpha.1",
            }
        return {
            "source": candidate["source"],
            "path": candidate["path"],
            "status": "failed",
            "reason": "old",
        }

    monkeypatch.setattr(
        capabilities,
        "codex_candidate_paths",
        lambda: [
            {"source": "app", "path": str(app)},
            {"source": "cli", "path": str(old_cli)},
        ],
    )
    monkeypatch.setattr(capabilities, "_check_codex_candidate", fake_check)

    report, selected = asyncio.run(capabilities.discover_codex_capability())

    assert selected is not None
    assert selected.path == str(app)
    assert checked == ["app"]
    assert report["history"] == "ok"
    assert report["execution"] == "ok"
    assert report["selected"]["source"] == "app"


def test_codex_capability_reports_checked_paths_when_unavailable(monkeypatch, tmp_path: Path) -> None:
    missing = tmp_path / "missing-codex"

    monkeypatch.setattr(
        capabilities,
        "codex_candidate_paths",
        lambda: [
            {"source": "app", "path": str(missing)},
        ],
    )

    report, selected = asyncio.run(capabilities.discover_codex_capability())

    assert selected is None
    assert report["history"] == "unavailable"
    assert report["execution"] == "unavailable"
    assert report["error"]["code"] == "codex_unavailable"
    assert "Plugin-based Codex installations are not supported yet" in report["error"]["message"]
    assert report["checked"][0]["status"] == "missing"


def test_codex_capability_extra_candidate_is_tried_first(monkeypatch, tmp_path: Path) -> None:
    """`extra_candidate` (used by the per-runtime scan endpoint when the user
    types a custom path in the Add Agent modal) must be probed before the
    built-in candidate list, and it should win when it succeeds.
    """
    custom_codex = tmp_path / "my-codex"
    cli_codex = tmp_path / "cli-codex"
    _write_executable(custom_codex, "#!/usr/bin/env sh\necho codex 1.0\n")
    _write_executable(cli_codex, "#!/usr/bin/env sh\necho codex 0.5\n")

    seen_paths: list[str] = []

    async def fake_check(candidate: dict[str, str]) -> dict[str, Any]:
        seen_paths.append(candidate["path"])
        return {
            "source": candidate["source"],
            "path": candidate["path"],
            "status": "ok" if candidate["path"] == str(custom_codex) else "missing",
        }

    monkeypatch.setattr(
        capabilities,
        "codex_candidate_paths",
        lambda: [{"source": "cli", "path": str(cli_codex)}],
    )
    monkeypatch.setattr(capabilities, "_check_codex_candidate", fake_check)

    report, selected = asyncio.run(
        capabilities.discover_codex_capability(extra_candidate=str(custom_codex))
    )

    assert seen_paths == [str(custom_codex)]
    assert selected is not None
    assert selected.path == str(custom_codex)
    assert report["selected"]["source"] == "custom"


def test_codex_capability_extra_candidate_falls_through_when_missing(
    monkeypatch, tmp_path: Path
) -> None:
    """If the custom path doesn't pan out, discovery falls through to the
    standard candidates — the modal then shows whatever the standard scan
    found (success or failure)."""
    nonexistent = tmp_path / "not-here-codex"
    fallback_codex = tmp_path / "fallback-codex"

    async def fake_check(candidate: dict[str, str]) -> dict[str, Any]:
        if candidate["path"] == str(nonexistent):
            return {
                "source": candidate["source"],
                "path": candidate["path"],
                "status": "missing",
                "reason": "file not found",
            }
        return {
            "source": candidate["source"],
            "path": candidate["path"],
            "status": "ok",
            "version": "codex-cli 0.135.0",
        }

    monkeypatch.setattr(
        capabilities,
        "codex_candidate_paths",
        lambda: [{"source": "cli", "path": str(fallback_codex)}],
    )
    monkeypatch.setattr(capabilities, "_check_codex_candidate", fake_check)

    report, selected = asyncio.run(
        capabilities.discover_codex_capability(extra_candidate=str(nonexistent))
    )

    assert selected is not None
    assert selected.path == str(fallback_codex)
    assert report["execution"] == "ok"
    # `checked` keeps the missing custom entry for UI display
    sources = [c["source"] for c in report["checked"]]
    assert sources == ["custom", "cli"]
    assert report["checked"][0]["status"] == "missing"


def test_claude_capability_extra_candidate_is_tried_first(
    monkeypatch, tmp_path: Path
) -> None:
    custom_claude = tmp_path / "my-claude"
    _write_executable(
        custom_claude,
        """#!/usr/bin/env sh
if [ "$1" = "--version" ]; then echo "9.9.9"; exit 0; fi
if [ "$1" = "--help" ]; then echo "Usage: claude"; exit 0; fi
exit 9
""",
    )
    monkeypatch.setattr(capabilities, "_list_claude_sdk_sessions", lambda: [])
    monkeypatch.setattr(capabilities, "_claude_candidate_paths", lambda: [])

    report, selected = asyncio.run(
        capabilities.discover_claude_capability(extra_candidate=str(custom_claude))
    )

    assert selected is not None
    assert selected.path == str(custom_claude)
    assert report["selected"]["source"] == "custom"
    assert report["selected"]["version"] == "9.9.9"


def test_claude_capability_extra_candidate_missing_keeps_other_candidates(
    monkeypatch, tmp_path: Path
) -> None:
    custom = tmp_path / "no-such-claude"
    other_claude = tmp_path / "other-claude"
    _write_executable(
        other_claude,
        """#!/usr/bin/env sh
if [ "$1" = "--version" ]; then echo "2.0"; exit 0; fi
if [ "$1" = "--help" ]; then echo "Usage: claude"; exit 0; fi
exit 9
""",
    )
    monkeypatch.setattr(capabilities, "_list_claude_sdk_sessions", lambda: [])
    monkeypatch.setattr(
        capabilities,
        "_claude_candidate_paths",
        lambda: [{"source": "cli", "path": str(other_claude)}],
    )

    report, selected = asyncio.run(
        capabilities.discover_claude_capability(extra_candidate=str(custom))
    )

    assert selected is not None
    assert selected.path == str(other_claude)
    sources = [c["source"] for c in report["checked"]]
    assert sources == ["custom", "cli"]
    assert report["checked"][0]["status"] == "missing"


def test_launch_target_wraps_windows_script_types(monkeypatch) -> None:
    monkeypatch.setattr(launch.sys, "platform", "win32")
    monkeypatch.setattr(launch.shutil, "which", lambda _name: "powershell.exe")

    ps1 = launch.launch_target("cli", r"C:\nvm4w\nodejs\codex.ps1")
    assert ps1.launcher == "powershell"
    assert ps1.command(["--version"]) == [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        r"C:\nvm4w\nodejs\codex.ps1",
        "--version",
    ]

    cmd = launch.launch_target("cli", r"C:\Users\admin\AppData\Roaming\npm\codex.cmd")
    assert cmd.launcher == "cmd"
    assert cmd.command(["--version"]) == [
        "powershell.exe",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "& 'C:\\Users\\admin\\AppData\\Roaming\\npm\\codex.cmd' '--version'",
    ]

    exe = launch.launch_target("cli", r"C:\Users\admin\.local\bin\claude.exe")
    assert exe.launcher == "direct"
    assert exe.command(["--help"]) == [r"C:\Users\admin\.local\bin\claude.exe", "--help"]


def test_windows_codex_candidates_include_common_cli_shims(monkeypatch) -> None:
    monkeypatch.setattr(codex_rpc.sys, "platform", "win32")
    monkeypatch.setenv("APPDATA", r"C:\Users\admin\AppData\Roaming")
    monkeypatch.setenv("USERPROFILE", r"C:\Users\admin")
    monkeypatch.setattr(codex_rpc.Path, "home", lambda: Path(r"C:\Users\admin"))
    monkeypatch.setattr(codex_rpc.shutil, "which", lambda name: r"C:\nvm4w\nodejs\codex.ps1" if name == "codex" else None)

    paths = [_win_norm(candidate["path"]) for candidate in codex_rpc.codex_candidate_paths()]

    assert paths[0] == r"C:\nvm4w\nodejs\codex.cmd"
    assert r"C:\nvm4w\nodejs\codex.cmd" in paths
    assert r"C:\Users\admin\AppData\Roaming\npm\codex.ps1" in paths
    assert r"C:\Users\admin\.local\bin\codex.exe" in paths
    assert r"C:\Users\admin\scoop\shims\codex.exe" in paths


def test_windows_claude_candidates_include_local_bin_and_shims(monkeypatch) -> None:
    monkeypatch.setattr(capabilities.sys, "platform", "win32")
    monkeypatch.setenv("APPDATA", r"C:\Users\admin\AppData\Roaming")
    monkeypatch.setenv("USERPROFILE", r"C:\Users\admin")
    monkeypatch.setattr(capabilities.Path, "home", lambda: Path(r"C:\Users\admin"))
    monkeypatch.setattr(capabilities.shutil, "which", lambda name: r"C:\Users\admin\.local\bin\claude.exe" if name == "claude" else None)

    paths = [_win_norm(candidate["path"]) for candidate in capabilities._claude_candidate_paths()]

    assert paths[0] == r"C:\Users\admin\.local\bin\claude.exe"
    assert r"C:\Users\admin\.local\bin\claude.cmd" in paths
    assert r"C:\Users\admin\AppData\Roaming\npm\claude.ps1" in paths
    assert r"C:\nvm4w\nodejs\claude.ps1" in paths
    assert r"C:\Users\admin\scoop\shims\claude.exe" in paths


def _win_norm(path: str) -> str:
    return path.replace("/", "\\")
