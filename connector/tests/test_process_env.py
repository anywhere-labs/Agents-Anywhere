from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest

from connector.local.terminal import TerminalBackend
from connector.paths import connector_data_dir
from connector.process_env import (
    INJECTED_ENV_VAR,
    child_environment,
    connector_env,
    isolate_process_environment,
)
from connector.runtimes.claude import provider_config as claude_provider_config
from connector.runtimes.codex import provider_config as codex_provider_config
from connector.runtimes.codex.sdk import binary as codex_binary

SCRIPTS = "Scripts" if os.name == "nt" else "bin"


@pytest.fixture
def venv(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Pretend the Connector runs from a uv-managed venv, as Desktop starts it."""

    prefix = tmp_path / "connector-venv"
    monkeypatch.setattr(sys, "prefix", str(prefix))
    monkeypatch.setattr(sys, "base_prefix", str(tmp_path / "python"))
    return prefix


def launched_environment(venv: Path, user: dict[str, str]) -> dict[str, str]:
    """What Desktop plus ``uv run`` hand the Connector on top of the user's environment."""

    injected = {
        "UV_PROJECT_ENVIRONMENT": str(venv),
        "UV_CACHE_DIR": "/aa/uv-cache",
        "UV_INDEX_URL": "https://pypi.org/simple",
        "PIP_INDEX_URL": "https://pypi.org/simple",
        "FORCE_COLOR": "0",
        "PYTHONUNBUFFERED": "1",
    }
    return {
        **user,
        **injected,
        INJECTED_ENV_VAR: json.dumps({name: user.get(name) for name in injected}),
        "AA_CONNECTOR_OWNER_KIND": "desktop-workbench",
        "AGENT_CONNECTOR_DATA_DIR": "/aa/connector",
        "AGENT_CONNECTOR_TOKEN": "secret",
        "AGENT_SERVER_URL": "https://aa.example",
        "VIRTUAL_ENV": str(venv),
        "UV": "/aa/uv",
        "UV_RUN_RECURSION_DEPTH": "1",
        "PATH": os.pathsep.join([str(venv / SCRIPTS), user["PATH"]]),
    }


def user_environment() -> dict[str, str]:
    return {
        "PATH": os.pathsep.join(["/usr/local/bin", "/usr/bin"]),
        "HOME": "/home/user",
        "UV_INDEX_URL": "https://mirror.example/simple",
        "AGENT_SERVER_TEST_DB_URL": "postgresql://localhost/aa_test",
    }


def test_child_environment_returns_the_users_environment(venv: Path) -> None:
    user = user_environment()

    assert child_environment(launched_environment(venv, user)) == user


def test_child_environment_is_idempotent(venv: Path) -> None:
    clean = child_environment(launched_environment(venv, user_environment()))

    assert child_environment(clean) == clean


def test_child_environment_keeps_another_virtual_env_and_path_entries(venv: Path) -> None:
    other = str(venv.parent / "project" / ".venv")
    environment = {
        "VIRTUAL_ENV": other,
        "PATH": os.pathsep.join([os.path.join(other, SCRIPTS), str(venv / SCRIPTS), "/usr/bin"]),
    }

    assert child_environment(environment) == {
        "VIRTUAL_ENV": other,
        "PATH": os.pathsep.join([os.path.join(other, SCRIPTS), "/usr/bin"]),
    }


def test_child_environment_keeps_path_outside_a_venv(tmp_path: Path) -> None:
    python = str(tmp_path / "python")
    environment = {"PATH": os.pathsep.join([os.path.join(python, SCRIPTS), "/usr/bin"]), "UV": "/aa/uv"}

    assert child_environment(environment, prefix=python, base_prefix=python) == {
        "PATH": environment["PATH"],
    }


def test_child_environment_ignores_a_malformed_marker(venv: Path) -> None:
    environment = {INJECTED_ENV_VAR: "{not json", "FORCE_COLOR": "0", "HOME": "/home/user"}

    assert child_environment(environment) == {"FORCE_COLOR": "0", "HOME": "/home/user"}


def test_isolate_process_environment_keeps_connector_settings_private(
    venv: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = user_environment()
    for name in list(os.environ):
        monkeypatch.delenv(name)
    for name, value in launched_environment(venv, user).items():
        monkeypatch.setenv(name, value)

    isolate_process_environment()

    assert dict(os.environ) == user
    assert connector_env("AGENT_CONNECTOR_TOKEN") == "secret"
    assert connector_env("AA_CONNECTOR_OWNER_KIND") == "desktop-workbench"
    assert connector_data_dir() == Path("/aa/connector").resolve(strict=False)


class CapturingTerminalBackend(TerminalBackend):
    def __init__(self) -> None:
        super().__init__(notify=None)
        self.env: dict[str, str] | None = None

    def _spawn(self, argv: list[str], *, cwd: Path, env: dict[str, str], rows: int, cols: int) -> Any:
        self.env = env
        return type("FakePty", (), {"pid": 123})()

    def _read(self, pty: Any) -> bytes:
        return b""

    def _write_all(self, pty: Any, data: bytes) -> None:
        pass

    def _setwinsize(self, pty: Any, rows: int, cols: int) -> None:
        pass

    def _terminate(self, pty: Any) -> None:
        pass

    def _close(self, pty: Any) -> None:
        pass

    def _wait_exit_code(self, pty: Any) -> int | None:
        return 0


def use_launched_environment(venv: Path, monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    user = user_environment()
    for name in list(os.environ):
        monkeypatch.delenv(name)
    for name, value in launched_environment(venv, user).items():
        monkeypatch.setenv(name, value)
    return user


def test_terminal_starts_with_the_users_environment(
    venv: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = use_launched_environment(venv, monkeypatch)
    backend = CapturingTerminalBackend()

    asyncio.run(
        backend.create(
            {
                "terminalId": "trm_1",
                "sessionId": "sess_1",
                "root": str(tmp_path),
                "env": {"EXTRA": "1"},
            }
        )
    )

    assert backend.env == {
        **user,
        "TERM": "xterm-256color",
        "COLORTERM": "truecolor",
        "EXTRA": "1",
    }
    asyncio.run(backend.close({"terminalId": "trm_1"}))


@pytest.mark.parametrize("module", [claude_provider_config, codex_provider_config])
def test_runtime_merge_environment_starts_from_the_users_environment(
    module: Any,
    venv: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = use_launched_environment(venv, monkeypatch)

    assert module.merge_environment({"EXTRA": "1", "HOME": None}) == {
        **{name: value for name, value in user.items() if name != "HOME"},
        "EXTRA": "1",
    }


def test_codex_runtime_environment_starts_from_the_users_environment(
    venv: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user = use_launched_environment(venv, monkeypatch)
    monkeypatch.setattr(
        codex_binary,
        "read_login_shell_path",
        lambda: codex_binary.LoginShellPathResult(shell=None, path=None),
    )

    environment, _ = codex_binary.codex_runtime_environment({"EXTRA": "1"})

    assert environment == {**user, "EXTRA": "1"}

