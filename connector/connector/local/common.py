from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Awaitable, Callable


MAX_DIR_ENTRIES = 500
MAX_OUTPUT_CHARS = 64_000
MAX_READ_TEXT_BYTES = 4 * 1024 * 1024

Notify = Callable[[str, dict[str, Any]], Awaitable[None]]


class StaleFileError(Exception):
    """Raised when fs.writeFile's ifMatch check fails."""

    code = "stale"


def workspace_root(params: dict[str, Any]) -> Path:
    raw_root = params.get("root") or params.get("cwd")
    if not isinstance(raw_root, str) or not raw_root.strip():
        raise ValueError("root is required")
    return Path(raw_root).expanduser().resolve(strict=False)


def resolve_path(root: Path, raw_path: str) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = root / path
    return path.resolve(strict=False)


def nearest_existing_dir(path: Path, *, fallback: Path | None = None) -> Path:
    """Return `path` if it is a directory, otherwise the closest existing parent.

    Workspace paths can point at projects that were deleted or moved after a
    session was recorded. Runtime panels should still open somewhere useful
    instead of failing on a stale cwd/path.
    """
    current = path
    while True:
        if current.is_dir():
            return current
        parent = current.parent
        if parent == current:
            break
        current = parent
    if fallback is not None:
        fallback_current = fallback
        while True:
            if fallback_current.is_dir():
                return fallback_current
            parent = fallback_current.parent
            if parent == fallback_current:
                break
            fallback_current = parent
    return Path.cwd()


def required_string(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} is required")
    return value


def required_text(params: dict[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str):
        raise ValueError(f"{key} is required")
    return value


def required_int(params: dict[str, Any], key: str) -> int:
    value = params.get(key)
    if not isinstance(value, int):
        raise ValueError(f"{key} is required")
    return value


def encoding(params: dict[str, Any]) -> str:
    value = params.get("encoding", "utf8")
    if value not in {"utf8", "utf-8"}:
        raise ValueError("only utf8 encoding is supported")
    return "utf-8"


def decode_output(output: bytes) -> tuple[str, bool]:
    text = output.decode("utf-8", errors="replace")
    if len(text) <= MAX_OUTPUT_CHARS:
        return text, False
    return text[:MAX_OUTPUT_CHARS], True


def shell_result(
    cwd: Path,
    command: str,
    exit_code: int | None,
    timed_out: bool,
    start: float,
    stdout: bytes,
    stderr: bytes,
) -> dict[str, Any]:
    stdout_text, stdout_truncated = decode_output(stdout)
    stderr_text, stderr_truncated = decode_output(stderr)
    return {
        "cwd": str(cwd),
        "command": command,
        "exitCode": exit_code,
        "timedOut": timed_out,
        "durationMs": int((time.monotonic() - start) * 1000),
        "stdout": stdout_text,
        "stderr": stderr_text,
        "stdoutTruncated": stdout_truncated,
        "stderrTruncated": stderr_truncated,
    }
