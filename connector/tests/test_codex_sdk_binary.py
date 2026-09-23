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


@pytest.mark.parametrize("suffix", [".exe", ".cmd", ".bat", ".ps1"])
def test_windows_path_discovers_launchers_without_pathext(
    monkeypatch, tmp_path, suffix
):
    monkeypatch.setattr(binary.sys, "platform", "win32")
    directory = tmp_path / "npm with spaces"
    directory.mkdir()
    (directory / "codex").write_text("POSIX shim")
    candidate = directory / ("codex" + suffix)
    candidate.write_text("")
    assert binary.find_executable_on_path("codex", str(directory)) == str(candidate)


def test_windows_path_preserves_directory_priority(monkeypatch, tmp_path):
    monkeypatch.setattr(binary.sys, "platform", "win32")
    first, second = tmp_path / "first", tmp_path / "second"
    first.mkdir()
    second.mkdir()
    (first / "codex.ps1").touch()
    (second / "codex.exe").touch()
    assert binary.find_executable_on_path("codex", f'"{first}";{second}') == str(
        first / "codex.ps1"
    )


def test_windows_does_not_run_posix_login_shell(monkeypatch):
    monkeypatch.setattr(binary.sys, "platform", "win32")
    monkeypatch.setenv("SHELL", "/bin/bash")
    monkeypatch.setattr(
        binary.subprocess, "run", lambda *a, **kw: pytest.fail("must use Windows PATH")
    )
    assert binary.read_login_shell_path().path is None


@pytest.mark.parametrize("suffix", [".ps1", ".cmd", ".bat"])
@pytest.mark.parametrize("configured", [False, True])
def test_windows_scripts_use_same_launcher_for_probe_and_sdk(
    monkeypatch, tmp_path, suffix, configured
):
    from types import SimpleNamespace

    from openai_codex import CodexConfig

    from connector.runtime_protocol import RuntimeConfig
    from connector.runtimes.codex.sdk.client import _sdk_config

    monkeypatch.setattr(binary.sys, "platform", "win32")
    directory = tmp_path / "npm user's tools"
    directory.mkdir()
    candidate = directory / ("codex" + suffix)
    candidate.touch()
    powershell = directory / "powershell.exe"
    powershell.touch()
    monkeypatch.setattr("connector.launch._powershell_bin", lambda: str(powershell))
    environment = {"PATH": str(directory)}
    commands = []

    def run(command, **kwargs):
        commands.append(command)
        assert command[0] == str(powershell)
        assert kwargs["env"]["PATH"] == str(directory)
        return subprocess.CompletedProcess(
            command, 0, stdout="codex-cli 0.144.4\n", stderr=""
        )

    monkeypatch.setattr(binary.subprocess, "run", run)
    values = {"environment": environment}
    if configured:
        values["codexExecutablePath"] = "codex" + suffix
    config = _sdk_config(
        SimpleNamespace(CodexConfig=CodexConfig),
        RuntimeConfig(runtime="codex", values=values, revision=1),
    )
    assert config.codex_bin == str(candidate)
    assert commands == [
        binary.codex_launch_command(str(candidate), ["--version"], environment)
    ]
    assert config.launch_args_override == tuple(
        binary.codex_launch_command(
            str(candidate), ["app-server", "--listen", "stdio://"], environment
        )
    )
    # Exercise the installed SDK's actual spawn boundary as well as its config.
    from openai_codex.client import CodexClient

    spawned = []
    monkeypatch.setattr(
        binary.subprocess,
        "Popen",
        lambda args, **kwargs: spawned.append(args) or object(),
    )
    sdk_client = CodexClient(config)
    monkeypatch.setattr(sdk_client, "_start_stderr_drain_thread", lambda: None)
    monkeypatch.setattr(sdk_client, "_start_reader_thread", lambda: None)
    sdk_client.start()
    assert spawned == [list(config.launch_args_override)]
    assert "-NonInteractive" in config.launch_args_override
    if suffix == ".ps1":
        assert config.launch_args_override[-4:] == (
            str(candidate),
            "app-server",
            "--listen",
            "stdio://",
        )
    else:
        assert "user''s" in config.launch_args_override[-1]
        assert config.launch_args_override[-1].endswith("; exit $LASTEXITCODE")


@pytest.mark.parametrize("suffix", [".ps1", ".cmd", ".bat"])
def test_windows_script_version_failure_falls_back(monkeypatch, suffix):
    monkeypatch.setattr(binary.sys, "platform", "win32")
    monkeypatch.setattr("connector.launch._powershell_bin", lambda: "powershell.exe")
    monkeypatch.setattr(
        binary.subprocess,
        "run",
        lambda command, **kwargs: subprocess.CompletedProcess(
            command, 7, stdout="codex-cli 0.144.4", stderr=""
        ),
    )
    selection = binary.select_codex_runtime_binary(
        "prefer_system",
        {},
        binary.LoginShellPathResult(None, None),
        configured_path="codex" + suffix,
    )
    assert selection.source == "sdk_bundled"
    assert "exited with code 7" in selection.reason
