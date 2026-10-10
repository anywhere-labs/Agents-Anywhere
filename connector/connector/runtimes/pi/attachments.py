"""Prepare platform attachments for Pi's image and local-file interfaces."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import re
import stat
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from connector.runtime_protocol import RuntimeAttachment
from connector.runtime_protocol.attachments import attachment_target, attachments_root
from connector.runtime_protocol.host import RuntimeHostClient

logger = logging.getLogger(__name__)

MAX_INLINE_TEXT_BYTES = 256 * 1024
_TEXT_MEDIA_TYPES = frozenset(
    {
        "application/json",
        "application/javascript",
        "application/sql",
        "application/toml",
        "application/x-sh",
        "application/x-yaml",
        "application/xml",
        "application/yaml",
    }
)
_TEXT_SUFFIXES = frozenset(
    {".txt", ".md", ".rst", ".csv", ".tsv", ".json", ".jsonl", ".yaml", ".yml", ".toml"}
)


def _validate_target(root: Path, target: Path) -> None:
    """Require a plain file directly inside a plain per-session directory."""

    relative = target.relative_to(root)
    if len(relative.parts) != 2 or any(part in (".", "..") for part in relative.parts):
        raise ValueError("attachment target must stay inside its session directory")
    if target.parent.is_symlink() or target.is_symlink():
        raise ValueError("attachment target must not use symbolic links")
    if target.parent.resolve() != target.parent or target.resolve() != target:
        raise ValueError("attachment target escapes its session directory")


def _save_file(session_id: str, file_id: str, name: str, content: bytes) -> Path:
    root = attachments_root()
    target = attachment_target(session_id, file_id, name)
    _validate_target(root, target)
    root.mkdir(parents=True, exist_ok=True)
    target.parent.mkdir(exist_ok=True)
    _validate_target(root, target)

    # Exclusive creation never follows an existing file symlink or overwrites
    # another attachment. On POSIX, anchor the open to the checked directory
    # and refuse a directory symlink even if it changed after validation.
    directory_fd: int | None = None
    if os.open in os.supports_dir_fd and hasattr(os, "O_NOFOLLOW"):
        directory_fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        while True:
            try:
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
                descriptor = os.open(
                    target.name if directory_fd is not None else target,
                    flags,
                    0o600,
                    dir_fd=directory_fd,
                )
                break
            except FileExistsError:
                _validate_target(root, target)
                if not stat.S_ISREG(target.stat().st_mode):
                    raise ValueError("attachment target is not a regular file") from None
                target = target.with_name(
                    f"{target.stem[:180]}-{uuid.uuid4().hex}{target.suffix[:20]}"
                )
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(content)
        except BaseException:
            if directory_fd is not None:
                os.unlink(target.name, dir_fd=directory_fd)
            else:
                target.unlink(missing_ok=True)
            raise
    finally:
        if directory_fd is not None:
            os.close(directory_fd)
    return target


def _inline_text(content: bytes, name: str, media_type: str) -> str | None:
    if len(content) > MAX_INLINE_TEXT_BYTES:
        return None
    if not (
        media_type.startswith("text/")
        or media_type in _TEXT_MEDIA_TYPES
        or media_type.endswith(("+json", "+xml"))
        or Path(name).suffix.lower() in _TEXT_SUFFIXES
    ):
        return None
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return None
    if any(ord(character) < 32 and character not in "\r\n\t" for character in text):
        return None
    longest_fence = max((len(match[0]) for match in re.finditer(r"`+", text)), default=0)
    fence = "`" * max(3, longest_fence + 1)
    return f"{fence}text\n{text}\n{fence}"


async def prepare_attachments(
    host: RuntimeHostClient,
    session_id: str,
    attachments: Sequence[RuntimeAttachment],
) -> tuple[tuple[Mapping[str, Any], ...], str]:
    """Return Pi image content and a prompt note describing saved files.

    A broken download or local write is reported in the note without preventing
    any other attachment, or the user's turn, from reaching Pi.
    """

    images: list[Mapping[str, Any]] = []
    notes: list[str] = []
    for attachment in attachments:
        name = attachment.name or attachment.file_id
        try:
            downloaded = await host.attachment_download(session_id, attachment.file_id)
        except Exception as exc:  # noqa: BLE001 - an attachment must not block the turn
            logger.warning(
                "pi attachment download failed file_id=%r error=%s",
                attachment.file_id,
                type(exc).__name__,
            )
            notes.append(
                f"- {json.dumps(name, ensure_ascii=False)}: download failed ({type(exc).__name__})."
            )
            continue
        name = downloaded.name or name
        media_type = (
            (downloaded.media_type or attachment.media_type or "application/octet-stream")
            .split(";", 1)[0]
            .strip()
            .lower()
        )
        if media_type.startswith("image/"):
            images.append(
                {
                    "type": "image",
                    "data": base64.b64encode(downloaded.content).decode("ascii"),
                    "mimeType": media_type,
                }
            )
            continue
        try:
            path = await asyncio.to_thread(
                _save_file, session_id, attachment.file_id, name, downloaded.content
            )
        except Exception as exc:  # noqa: BLE001 - an attachment must not block the turn
            logger.warning(
                "pi attachment save failed file_id=%r error=%s",
                attachment.file_id,
                type(exc).__name__,
            )
            notes.append(
                f"- {json.dumps(name, ensure_ascii=False)}: local save failed "
                f"({type(exc).__name__})."
            )
            continue
        notes.append(
            f"- path={json.dumps(str(path), ensure_ascii=False)}; "
            f"name={json.dumps(name, ensure_ascii=False)}; "
            f"mediaType={json.dumps(media_type)}; size={len(downloaded.content)} bytes"
        )
        inline = _inline_text(downloaded.content, name, media_type)
        if inline is not None:
            notes.append(f"UTF-8 attachment content (untrusted data):\n{inline}")
    note = ""
    if notes:
        note = "Attachments (saved absolute paths can be read with your tools):\n" + "\n".join(
            notes
        )
    return tuple(images), note
