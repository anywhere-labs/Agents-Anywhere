from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest
from connector.runtimes.codex.sdk import binary


def test_connector_cli_starts_without_unix_pwd_module() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; sys.modules['pwd'] = None; "
                "from connector.cli import main; main(['--help'])"
            ),
        ],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True,
        check=False,
        text=True,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    assert "usage:" in result.stdout


@pytest.mark.parametrize("configured", [False, True])
@pytest.mark.parametrize(
    "failure", ["winerror", "timeout", "exit", "empty", "unrelated"]
)
def test_invalid_codex_falls_back_to_sdk(monkeypatch, configured, failure):
    monkeypatch.setattr(binary, "find_executable_on_path", lambda *_: "codex.cmd")

    def run(command, **kwargs):
        assert command == ["codex.cmd", "--version"]
        assert kwargs["env"] == {"PATH": "example"}
        assert kwargs["timeout"] == 5.0
        if failure == "winerror":
            raise OSError(193, "%1 is not a valid Win32 application")
        if failure == "timeout":
            raise subprocess.TimeoutExpired(command, 5)
        return subprocess.CompletedProcess(
            command,
            1 if failure == "exit" else 0,
            stdout="node 1.2.3" if failure == "unrelated" else "",
            stderr="",
        )

    monkeypatch.setattr(binary.subprocess, "run", run)
    selection = binary.select_codex_runtime_binary(
        "prefer_system",
        {"PATH": "example"},
        binary.LoginShellPathResult(None, None),
        configured_path="codex.cmd" if configured else None,
    )
    assert selection.source == "sdk_bundled"
    assert selection.codex_bin is None
    assert "version check failed" in selection.reason


@pytest.mark.parametrize("configured", [False, True])
def test_valid_codex_is_used(monkeypatch, configured):
    monkeypatch.setattr(binary, "find_executable_on_path", lambda *_: "codex.exe")
    monkeypatch.setattr(
        binary.subprocess,
        "run",
        lambda *a, **kw: subprocess.CompletedProcess(
            a[0],
            0,
            stdout="codex-cli 0.144.4\n",
            stderr="",
        ),
    )
    selection = binary.select_codex_runtime_binary(
        "prefer_system",
        {},
        binary.LoginShellPathResult(None, None),
        configured_path="codex.exe" if configured else None,
    )
    assert selection.source == ("configured" if configured else "system")
    assert selection.codex_bin == "codex.exe"


def test_disabled_system_codex_does_not_probe(monkeypatch):
    def unexpected(*args, **kwargs):
        pytest.fail("SDK mode should not search or probe system Codex")

    monkeypatch.setattr(binary, "find_executable_on_path", unexpected)
    monkeypatch.setattr(binary.subprocess, "run", unexpected)
    selection = binary.select_codex_runtime_binary(
        "sdk_bundled",
        {},
        binary.LoginShellPathResult(None, None),
    )
    assert selection.source == "sdk_bundled"
