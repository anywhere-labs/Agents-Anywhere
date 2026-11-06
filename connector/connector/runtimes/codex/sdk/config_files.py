from __future__ import annotations

import datetime
import os
import re
import tempfile
import threading
import tomllib
from pathlib import Path

from connector.logging import logger
from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtimes.codex.sdk.model_gateway import (
    CODEX_MODEL_GATEWAY_PROVIDER_ID,
    codex_model_gateway_config,
)
from connector.runtimes.model_gateway import ModelGateway

_WRITE_LOCK = threading.RLock()
_MANAGED_MARKER = (
    "# Managed by Agents Anywhere; updated whenever the Codex runtime starts."
)
_MAX_CONFIG_BACKUPS = 5


def persist_codex_model_gateway(
    codex_home: str,
    gateway: ModelGateway | None,
) -> None:
    """Expose the managed gateway provider to every Codex client.

    Codex persists a thread's provider id, but provider definitions passed only
    to ``thread/start`` are not written to its config. Persisting this one table
    lets Codex Desktop resume the same thread without a one-off SDK override.
    """

    path = _config_path(codex_home)
    with _WRITE_LOCK:
        try:
            original_exists = path.exists()
            original = path.read_text(encoding="utf-8") if path.exists() else ""
            ranges = _provider_table_ranges(original)
            if gateway is None:
                lines = original.splitlines(keepends=True)
                managed = [
                    (start, end)
                    for start, end in ranges
                    if _contains_managed_marker(lines[start:end])
                ]
                if not managed:
                    return
                updated = _remove_tables(original, managed)
            else:
                updated = _replace_tables(
                    original,
                    ranges,
                    _provider_table(gateway),
                )
            _validate_config(updated)
            if updated == original:
                _ensure_private_file(path)
                return
            if original_exists and original:
                _backup_config(path, original)
            _atomic_write(path, updated)
            _prune_config_backups(path)
        except RuntimeInvalidRequestError:
            raise
        except (OSError, UnicodeError, tomllib.TOMLDecodeError) as exc:
            raise RuntimeInvalidRequestError(
                f"Codex model gateway configuration could not be written: {path}"
            ) from exc


def _config_path(codex_home: str) -> Path:
    path = Path(codex_home) / "config.toml"
    if path.is_symlink():
        return path.resolve(strict=False)
    return path


def _provider_table_ranges(contents: str) -> list[tuple[int, int]]:
    lines = contents.splitlines(keepends=True)
    ranges: list[tuple[int, int]] = []
    start: int | None = None
    end = 0
    index = 0
    while index < len(lines):
        path = _table_path(lines[index])
        is_managed = path is not None and path[:2] == (
            "model_providers",
            CODEX_MODEL_GATEWAY_PROVIDER_ID,
        )
        if is_managed:
            if start is None:
                start = (
                    index - 1
                    if index > 0 and _is_managed_marker(lines[index - 1])
                    else index
                )
            end = index + 1
        elif start is not None:
            if path is not None:
                ranges.append((start, end))
                start = None
            else:
                end = index + 1
        index += 1
    if start is not None:
        ranges.append((start, end))
    return ranges


def _table_path(line: str) -> tuple[str, ...] | None:
    stripped = line.lstrip()
    if not _is_table_header(stripped):
        return None
    return _table_path_without_guard(stripped)


def _is_table_header(line: str) -> bool:
    stripped = line.strip()
    if not stripped.startswith("["):
        return False
    try:
        return _table_path_without_guard(stripped) is not None
    except RecursionError:
        return False


def _table_path_without_guard(line: str) -> tuple[str, ...] | None:
    try:
        parsed = tomllib.loads(line.rstrip("\r\n") + "\n")
    except tomllib.TOMLDecodeError:
        return None
    path: list[str] = []
    value: object = parsed
    while isinstance(value, dict) and len(value) == 1:
        key, value = next(iter(value.items()))
        path.append(key)
    return tuple(path) if path else None


def _contains_managed_marker(lines: list[str]) -> bool:
    return any(_is_managed_marker(line) for line in lines)


def _is_managed_marker(line: str) -> bool:
    return line.strip() == _MANAGED_MARKER


def _replace_tables(
    contents: str,
    ranges: list[tuple[int, int]],
    replacement: str,
) -> str:
    if not ranges:
        prefix = contents
        if prefix and not prefix.endswith("\n"):
            prefix += "\n"
        if prefix and not prefix.endswith("\n\n"):
            prefix += "\n"
        return prefix + replacement

    lines = contents.splitlines(keepends=True)
    output: list[str] = []
    previous = 0
    for range_index, (start, end) in enumerate(ranges):
        output.extend(lines[previous:start])
        if range_index == 0:
            if output and output[-1].strip():
                output.append("\n")
            output.append(replacement)
        previous = end
    output.extend(lines[previous:])
    return "".join(output)


def _remove_tables(contents: str, ranges: list[tuple[int, int]]) -> str:
    lines = contents.splitlines(keepends=True)
    output: list[str] = []
    previous = 0
    for start, end in ranges:
        output.extend(lines[previous:start])
        previous = end
    output.extend(lines[previous:])
    return "".join(output)


def _provider_table(gateway: ModelGateway) -> str:
    provider = codex_model_gateway_config(gateway)["model_providers"][
        CODEX_MODEL_GATEWAY_PROVIDER_ID
    ]
    return (
        f"{_MANAGED_MARKER}\n"
        f"[model_providers.{CODEX_MODEL_GATEWAY_PROVIDER_ID}]\n"
        f"name = {_toml_string(provider['name'])}\n"
        f"base_url = {_toml_string(provider['base_url'])}\n"
        "wire_api = \"responses\"\n"
        "requires_openai_auth = false\n"
        f"experimental_bearer_token = {_toml_string(provider['experimental_bearer_token'])}\n"
    )


def _toml_string(value: str) -> str:
    escaped = (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\b", "\\b")
        .replace("\t", "\\t")
        .replace("\n", "\\n")
        .replace("\f", "\\f")
        .replace("\r", "\\r")
    )
    return f'"{escaped}"'


def _validate_config(contents: str) -> None:
    try:
        tomllib.loads(contents)
    except tomllib.TOMLDecodeError as exc:
        raise RuntimeInvalidRequestError(
            "Codex config.toml is invalid after updating the model gateway"
        ) from exc


def _backup_config(path: Path, contents: str) -> None:
    stamp = datetime.datetime.now(datetime.UTC).strftime("%Y%m%dT%H%M%S%fZ")
    backup = path.with_name(f"{path.name}.backup.{stamp}")
    suffix = 1
    while backup.exists():
        backup = path.with_name(f"{path.name}.backup.{stamp}.{suffix}")
        suffix += 1
    _atomic_write(backup, contents)


def _prune_config_backups(path: Path) -> None:
    pattern = re.compile(
        rf"^{re.escape(path.name)}\.backup\."
        r"(\d{8}T\d{12}Z)(?:\.(\d+))?$"
    )
    backups: list[tuple[tuple[str, int], Path]] = []
    for candidate in path.parent.glob(f"{path.name}.backup.*"):
        match = pattern.fullmatch(candidate.name)
        if match is None or not candidate.is_file():
            continue
        sort_key = (match.group(1), int(match.group(2) or 0))
        backups.append((sort_key, candidate))
    backups.sort(reverse=True)
    for _, backup in backups[_MAX_CONFIG_BACKUPS:]:
        try:
            backup.unlink()
        except OSError as exc:
            logger.warning(
                "failed to prune Codex config backup path={} error={}",
                backup,
                exc,
            )


def _atomic_write(path: Path, contents: str, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    temporary_path: Path | None = None
    descriptor = -1
    try:
        descriptor, raw_path = tempfile.mkstemp(
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
        )
        temporary_path = Path(raw_path)
        with os.fdopen(descriptor, "w", encoding="utf-8") as temporary:
            descriptor = -1
            temporary.write(contents)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temporary_path, mode)
        os.replace(temporary_path, path)
    finally:
        if descriptor >= 0:
            try:
                os.close(descriptor)
            except OSError:
                pass
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()


def _ensure_private_file(path: Path) -> None:
    if os.name != "nt":
        path.chmod(0o600)


__all__ = ["persist_codex_model_gateway"]
