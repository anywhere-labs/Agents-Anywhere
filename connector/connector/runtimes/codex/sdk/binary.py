from __future__ import annotations

import os
import re
import shutil
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
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
        import pwd

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
    candidate = configured_path
    source: CodexRuntimeBinarySource = "configured"
    reason = "system Codex disabled by useSystemCodex"
    if candidate is None and mode == "prefer_system":
        candidate = find_executable_on_path("codex", environment.get("PATH"))
        source = "system"
        reason = "system codex binary was not found on PATH"

    if candidate is not None:
        error = codex_version_error(candidate, environment)
        if error is None:
            return CodexRuntimeBinarySelection(
                mode=mode,
                source=source,
                codex_bin=candidate,
                login_shell=shell_path.shell,
                login_shell_path=shell_path.path,
                reason="configured by codexExecutablePath"
                if source == "configured"
                else None,
            )
        reason = f"{source} Codex version check failed: {error}"
        logger.warning("{}; falling back to SDK Codex path={}", reason, candidate)

    return CodexRuntimeBinarySelection(
        mode=mode,
        source="sdk_bundled",
        codex_bin=None,
        login_shell=shell_path.shell,
        login_shell_path=shell_path.path,
        reason=reason,
    )


def codex_version_error(candidate: str, environment: Mapping[str, str]) -> str | None:
    """Validate the executable with the same environment used by the SDK."""
    try:
        result = subprocess.run(
            [candidate, "--version"],
            env=dict(environment),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=5.0,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return str(exc) or exc.__class__.__name__
    if result.returncode != 0:
        return f"exited with code {result.returncode}"
    if (
        re.search(
            r"(?m)^codex(?:-cli)? \d+\.\d+\.\d+(?:[-+][\w.-]+)?\s*$", result.stdout
        )
        is None
    ):
        return "missing or invalid Codex version output"
    return None


def find_executable_on_path(name: str, path_value: str | None) -> str | None:
    if path_value is None:
        return None
    # shutil.which honors Windows PATHEXT, unlike looking for a bare npm shim.
    search_path = os.pathsep.join(
        os.path.expanduser(directory)
        for directory in path_value.split(os.pathsep)
        if directory
    )
    return shutil.which(name, path=search_path)


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
