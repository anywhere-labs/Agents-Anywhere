from pathlib import Path

import pytest

from connector.runtimes.pi import launcher


def test_resolve_windows_npm_shim(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    shim = tmp_path / "pi.cmd"
    shim.write_text("@echo off\n")
    cli = tmp_path / launcher.CLI_RELATIVE
    cli.parent.mkdir(parents=True)
    cli.write_text("")
    node = tmp_path / "node.exe"
    node.write_text("")
    monkeypatch.setattr(launcher.sys, "platform", "win32")
    assert launcher.resolve_pi_command(str(shim)) == [str(node), str(cli)]


def test_resolve_plain_executable(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    exe = tmp_path / "pi"
    exe.write_text("")
    monkeypatch.setattr(launcher.sys, "platform", "linux")
    assert launcher.resolve_pi_command(str(exe)) == [str(exe)]
    assert launcher.resolve_pi_command(str(tmp_path / "missing")) is None
