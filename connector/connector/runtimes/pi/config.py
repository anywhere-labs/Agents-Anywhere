"""Pi runtime configuration values and JSON schema."""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from connector.runtime_protocol import RuntimeInvalidRequestError

from .permissions import (
    DEFAULT_PERMISSION_MODE,
    PERMISSION_MODES,
    validate_permission_mode,
)

logger = logging.getLogger(__name__)

CONFIG_SCHEMA_REVISION = 2
DEFAULT_EXECUTABLE = "pi"
DEFAULT_SESSIONS_DIR = "~/.pi/agent/sessions"
DEFAULT_CWD = "~"
DEFAULT_REQUEST_TIMEOUT_MS = 60_000
DEFAULT_IDLE_TIMEOUT_SECONDS = 600
PROBE_TIMEOUT_SECONDS = 20.0
PROBE_CACHE_SECONDS = 300.0
_probe_cache: dict[tuple[str, ...], tuple[float, str]] = {}


def _run_version(command: list[str]) -> subprocess.CompletedProcess[bytes]:
    kwargs: dict[str, Any] = {}
    if sys.platform == "win32":
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return subprocess.run(
        [*command, "--version"],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        timeout=PROBE_TIMEOUT_SECONDS,
        check=False,
        **kwargs,
    )


async def probe_pi_version(executable: str) -> str | None:
    """Return the ``pi --version`` string, or None when the binary is missing.

    A worker-local deadline avoids relying on the connector event loop to
    schedule subprocess I/O while it syncs history. A timeout still requires
    checking the executable, environment, process state, and machine load.
    """

    from .launcher import resolve_pi_command

    command = resolve_pi_command(executable)
    if command is None:
        return None
    key = tuple(command)
    cached = _probe_cache.get(key)
    if cached is not None and time.monotonic() - cached[0] < PROBE_CACHE_SECONDS:
        return cached[1]
    try:
        result = await asyncio.to_thread(_run_version, command)
    except subprocess.TimeoutExpired:
        logger.warning("pi --version timed out for %s", executable)
        return None
    except OSError as exc:
        logger.warning("cannot launch pi at %s: %s", executable, exc)
        return None
    if result.returncode != 0:
        logger.warning(
            "pi --version failed for %s: %s",
            executable,
            result.stderr.decode("utf-8", errors="replace").strip(),
        )
        return None
    version = result.stdout.decode("utf-8", errors="replace").strip()
    if version:
        _probe_cache[key] = (time.monotonic(), version)
    return version or None


def expand_sessions_dir(raw: str | None) -> Path:
    value = raw or os.environ.get("PI_CODING_AGENT_SESSION_DIR") or DEFAULT_SESSIONS_DIR
    return Path(value).expanduser()


def pi_config_schema() -> dict[str, Any]:
    positive_timeout = {"type": "integer", "minimum": 1_000, "maximum": 600_000}
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "executablePath": {
                "type": "string",
                "minLength": 1,
                "title": "pi 可执行文件",
                "description": "pi CLI 的路径或命令名。",
                "default": DEFAULT_EXECUTABLE,
            },
            "sessionsDir": {
                "type": "string",
                "minLength": 1,
                "title": "会话目录",
                "description": "Pi 会话文件目录，默认 ~/.pi/agent/sessions。",
                "default": DEFAULT_SESSIONS_DIR,
            },
            "defaultCwd": {
                "type": "string",
                "minLength": 1,
                "title": "默认工作目录",
                "description": "创建会话且未指定工作目录时使用。",
                "default": DEFAULT_CWD,
            },
            "requestTimeoutMs": {
                **positive_timeout,
                "title": "RPC 超时（毫秒）",
                "description": "单条 RPC 命令等待响应的最长时间。",
                "default": DEFAULT_REQUEST_TIMEOUT_MS,
            },
            "idleTimeoutSeconds": {
                "type": "integer",
                "minimum": 0,
                "maximum": 86400,
                "title": "空闲回收（秒）",
                "description": (
                    "空闲超过该时长的会话进程会被关闭（0 表示不回收）；"
                    "会话文件保留，下一条消息会自动恢复。"
                ),
                "default": DEFAULT_IDLE_TIMEOUT_SECONDS,
            },
            "permissionMode": {
                "type": "string",
                "enum": list(PERMISSION_MODES),
                "title": "工具权限",
                "description": "工具调用的默认审批模式，可在会话中单独切换。",
                "default": DEFAULT_PERMISSION_MODE,
            },
        },
        "additionalProperties": False,
    }


def default_config_values() -> dict[str, Any]:
    return {
        "executablePath": DEFAULT_EXECUTABLE,
        "sessionsDir": DEFAULT_SESSIONS_DIR,
        "defaultCwd": DEFAULT_CWD,
        "requestTimeoutMs": DEFAULT_REQUEST_TIMEOUT_MS,
        "idleTimeoutSeconds": DEFAULT_IDLE_TIMEOUT_SECONDS,
        "permissionMode": os.environ.get("PI_AA_PERMISSION_MODE", DEFAULT_PERMISSION_MODE),
    }


def normalized_config_values(raw: Mapping[str, Any]) -> dict[str, Any]:
    values: dict[str, Any] = {**default_config_values(), **raw}
    values["permissionMode"] = validate_permission_mode(values.get("permissionMode"))
    executable = values.get("executablePath")
    if not isinstance(executable, str) or not executable.strip():
        raise RuntimeInvalidRequestError("executablePath must be a non-empty string")
    values["executablePath"] = executable.strip()

    sessions_dir = values.get("sessionsDir")
    if not isinstance(sessions_dir, str) or not sessions_dir.strip():
        raise RuntimeInvalidRequestError("sessionsDir must be a non-empty string")
    values["sessionsDir"] = str(expand_sessions_dir(sessions_dir))

    default_cwd = values.get("defaultCwd")
    if not isinstance(default_cwd, str) or not default_cwd.strip():
        raise RuntimeInvalidRequestError("defaultCwd must be a non-empty string")
    values["defaultCwd"] = str(Path(default_cwd).expanduser())

    timeout = values.get("requestTimeoutMs")
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1_000 <= timeout <= 600_000:
        raise RuntimeInvalidRequestError(
            "requestTimeoutMs must be an integer between 1000 and 600000"
        )

    idle_timeout = values.get("idleTimeoutSeconds")
    if (
        not isinstance(idle_timeout, int)
        or isinstance(idle_timeout, bool)
        or not 0 <= idle_timeout <= 86_400
    ):
        raise RuntimeInvalidRequestError(
            "idleTimeoutSeconds must be an integer between 0 and 86400"
        )
    return values
