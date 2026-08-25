from __future__ import annotations

import os
import pwd
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from connector.logging import logger

CodexRuntimeBinaryMode = Literal["prefer_system", "sdk_bundled"]
CodexRuntimeBinarySource = Literal["configured", "system", "sdk_bundled"]

LOGIN_SHELL_PATH_MARKER = "__AGENTS_ANYWHERE_PATH__"


@dataclass(frozen=True, slots=True)
class LoginShellPathResult:
    shell: str | None
    path: str | None
    error: str | None = None


@dataclass(frozen=True, slots=True)
class CodexRuntimeBinarySelection:
    mode: CodexRuntimeBinaryMode
    source: CodexRuntimeBinarySource
    codex_bin: str | None
    login_shell: str | None
    login_shell_path: str | None
    reason: str | None = None


def default_login_shell() -> str | None:
    shell = os.environ.get("SHELL")
    if isinstance(shell, str) and shell:
        return shell

    if os.name == "posix":
        try:
            return pwd.getpwuid(os.getuid()).pw_shell
        except KeyError:
            return None

    return None


def read_login_shell_path(shell: str | None = None) -> LoginShellPathResult:
    """Read PATH after the user's login shell has loaded its shell rc files.

    Side effects:
    - starts the user's shell with login and interactive flags
    - waits up to a short timeout for shell initialization
    """

    selected_shell = shell or default_login_shell()
    if selected_shell is None:
        return LoginShellPathResult(
            shell=None,
            path=None,
            error="login shell is unavailable",
        )

    command = f'printf "{LOGIN_SHELL_PATH_MARKER}%s\\n" "$PATH"'
    try:
        completed = subprocess.run(
            [selected_shell, "-lic", command],
            check=False,
            capture_output=True,
            text=True,
            timeout=5.0,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return LoginShellPathResult(
            shell=selected_shell,
            path=None,
            error=str(exc) or exc.__class__.__name__,
        )

    for line in reversed(completed.stdout.splitlines()):
        if line.startswith(LOGIN_SHELL_PATH_MARKER):
            path_value = line.removeprefix(LOGIN_SHELL_PATH_MARKER)
            if path_value:
                return LoginShellPathResult(shell=selected_shell, path=path_value)

    stderr = completed.stderr.strip()
    reason = stderr or f"shell exited with code {completed.returncode}"
    return LoginShellPathResult(shell=selected_shell, path=None, error=reason)


def codex_runtime_environment(
    environment_overrides: Mapping[str, object] | None,
    *,
    codex_home: str | None = None,
) -> tuple[dict[str, str], LoginShellPathResult]:
    env = dict(os.environ)
    shell_path = read_login_shell_path()
    if shell_path.path is not None:
        env["PATH"] = shell_path.path
    elif shell_path.error is not None:
        logger.debug(
            "codex login shell PATH read failed shell={} error={}",
            shell_path.shell,
            shell_path.error,
        )

    if environment_overrides is None:
        if codex_home is not None:
            env["CODEX_HOME"] = codex_home
        return env, shell_path

    for key, value in environment_overrides.items():
        if value is None:
            env.pop(key, None)
            continue
        if isinstance(value, str):
            env[key] = value

    if codex_home is not None:
        env["CODEX_HOME"] = codex_home

    return env, shell_path


def select_codex_runtime_binary(
    mode: CodexRuntimeBinaryMode,
    environment: Mapping[str, str],
    shell_path: LoginShellPathResult,
    *,
    configured_path: str | None = None,
) -> CodexRuntimeBinarySelection:
    if configured_path is not None:
        return CodexRuntimeBinarySelection(
            mode=mode,
            source="configured",
            codex_bin=configured_path,
            login_shell=shell_path.shell,
            login_shell_path=shell_path.path,
            reason="configured by codexExecutablePath",
        )

    if mode == "sdk_bundled":
        return CodexRuntimeBinarySelection(
            mode=mode,
            source="sdk_bundled",
            codex_bin=None,
            login_shell=shell_path.shell,
            login_shell_path=shell_path.path,
            reason="system Codex disabled by useSystemCodex",
        )

    system_codex = find_executable_on_path("codex", environment.get("PATH"))
    if system_codex is not None:
        return CodexRuntimeBinarySelection(
            mode=mode,
            source="system",
            codex_bin=system_codex,
            login_shell=shell_path.shell,
            login_shell_path=shell_path.path,
        )

    return CodexRuntimeBinarySelection(
        mode=mode,
        source="sdk_bundled",
        codex_bin=None,
        login_shell=shell_path.shell,
        login_shell_path=shell_path.path,
        reason="system codex binary was not found on login shell PATH",
    )


def find_executable_on_path(name: str, path_value: str | None) -> str | None:
    if path_value is None:
        return None

    for raw_directory in path_value.split(os.pathsep):
        if not raw_directory:
            continue
        candidate = Path(raw_directory).expanduser() / name
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return str(candidate)

    return None


def runtime_binary_metadata(
    selection: CodexRuntimeBinarySelection,
) -> dict[str, object]:
    metadata: dict[str, object] = {
        "mode": selection.mode,
        "source": selection.source,
        "codexBin": selection.codex_bin,
        "loginShell": selection.login_shell,
        "loginShellPath": selection.login_shell_path,
    }
    if selection.reason is not None:
        metadata["reason"] = selection.reason
    return metadata
