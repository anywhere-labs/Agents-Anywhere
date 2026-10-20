"""Materialize platform attachments into local files opencode can read.

opencode accepts ``{"type": "file", "mime", "filename", "url"}`` parts on
``prompt_async``; the ``url`` may point at a local file (``file://`` URL),
which serve reads at prompt time and inlines into the model context. The
platform stores attachments server-side, so each part is first downloaded
through the runtime host and staged under the connector data directory.

The staged layout is ``<session>/<file_id>/<name>``: opencode echoes the
``url`` back verbatim in stored message parts, so the timeline mapper can
recover the platform ``fileId`` from the staged path's parent directory and
the client can render the attachment chip with its normal authenticated URL.
"""

from __future__ import annotations

import mimetypes
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, unquote

from connector.logging import logger
from connector.runtime_protocol import RuntimeAttachment
from connector.runtime_protocol.attachments import session_attachments_dir
from connector.runtime_protocol.host import RuntimeHostClient

FILE_ID_PREFIX = "file_"
_UNSAFE_RE = re.compile(r"[^\w.\-+]+")
GENERIC_MEDIA_TYPES = frozenset(
    {
        "application/octet-stream",
        "binary/octet-stream",
        "",
    }
)
# Bytes sampled when deciding whether a payload is text. Enough to catch a
# UTF-8 header, a BOM, or the first control bytes of any real binary format,
# without reading a 4 GB video into memory.
_TEXT_SNIFF_BYTES = 8192
# Control characters that never appear in source text but do in binary data.
# Tab, newline and carriage return are ordinary text.
_BINARY_CONTROL = re.compile(rb"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def looks_like_text(sample: bytes) -> bool:
    """Decide text vs binary from the bytes themselves.

    Deciding by file extension cannot be exhaustive -- the next format always
    arrives unlisted -- so the only durable signal is the payload. The BOM /
    UTF-16 checks come first because those encodings contain NUL bytes that
    would otherwise read as binary.
    """

    if not sample:
        return False
    for bom, encoding in ((b"\xff\xfe", "utf-16-le"), (b"\xfe\xff", "utf-16-be")):
        if sample.startswith(bom):
            try:
                sample[len(bom) :].decode(encoding)
            except UnicodeDecodeError:
                return False
            return True
    if sample.startswith(b"\xef\xbb\xbf"):
        sample = sample[3:]
    if b"\x00" in sample:
        # A NUL outside a UTF-16/UTF-32 document means binary.
        return False
    try:
        text = sample.decode("utf-8")
    except UnicodeDecodeError:
        return False
    # Control characters never appear in source text but do in binary data.
    # Tab, newline and carriage return are ordinary text.
    return _BINARY_CONTROL.search(text.encode("utf-8")) is None


def resolve_media_type(name: str, declared: str | None, sample: bytes = b"") -> str:
    """Pick a media type an openai-compatible provider will accept.

    The platform hands us ``application/octet-stream`` for anything it has not
    classified, and providers reject an unrecognised part media type instead of
    ignoring it, which fails the whole turn. An explicit, specific declared type
    always wins; otherwise the payload's own bytes decide, with the name only
    consulted through ``mimetypes`` for the exact type of a text file.
    """

    candidate = (declared or "").strip().lower()
    if candidate and candidate not in GENERIC_MEDIA_TYPES:
        return candidate
    if not looks_like_text(sample):
        return candidate or "application/octet-stream"
    guessed, _ = mimetypes.guess_type(name)
    if guessed and guessed.startswith("text/"):
        return guessed
    if guessed in {"application/json", "application/xml", "application/yaml", "application/x-yaml"}:
        return guessed
    return "text/plain"
# Separator used to embed the platform fileId into the opencode file part's
# ``filename`` field. opencode inlines ``file://`` URLs as ``data:`` URLs when
# it stores the message, which makes the staged-path-based fileId recovery in
# ``staged_file_id`` useless. The filename field is preserved verbatim, so we
# encode the fileId there (``file_xxx__real_name.ext``) and the timeline mapper
# splits it back. The ``__`` separator is safe because it cannot appear inside
# a platform-generated ``file_<token>`` id, and collisions with user file names
# that happen to contain ``__`` are extremely unlikely and would only cause a
# fallback to the synthetic ``opencode-<partId>`` id.
_FILE_ID_SEPARATOR = "__"


def safe_component(value: str, fallback: str) -> str:
    """Reduce a value to a single, filesystem-safe path component."""

    name = value.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    sanitized = _UNSAFE_RE.sub("_", name).strip("._")[:120]
    return sanitized or fallback


def file_url(path: str) -> str:
    """Build a ``file://`` URL opencode can read from a native path."""

    normalized = path.replace("\\", "/")
    if not normalized.startswith("/"):
        normalized = "/" + normalized
    return "file://" + quote(normalized, safe="/:")


def path_from_file_url(url: str) -> Path | None:
    """Parse a ``file://`` URL back into a native path.

    Windows drive paths travel as ``file:///C:/...``; strip the URL's leading
    slash so ``C:/...`` survives, otherwise opening the path fails with
    ``\\C:\\...``.
    """

    if not url.startswith("file://"):
        return None
    raw = unquote(url[len("file://") :])
    if len(raw) >= 3 and raw[0] == "/" and raw[1].isalpha() and raw[2] == ":":
        raw = raw[1:]
    return Path(raw)


def staged_file_id(url: str) -> str | None:
    """Recover the platform file id from a staged attachment URL.

    Returns ``None`` when the URL does not follow the staged layout (e.g.
    attachments created by the opencode web UI itself).
    """

    path = path_from_file_url(url)
    if path is None:
        return None
    parent = path.parent.name
    return parent if parent.startswith(FILE_ID_PREFIX) else None


def decode_filename(raw_name: str) -> tuple[str | None, str]:
    """Split a connector-encoded filename back into ``(fileId, realName)``.

    ``attachments.to_part`` embeds the platform fileId as ``<fileId>__<name>``
    so it survives opencode inlining ``file://`` URLs into ``data:`` URLs.
    Returns ``(None, raw_name)`` when the filename was not encoded by us
    (e.g. attachments uploaded via the opencode web UI).
    """

    if not raw_name or _FILE_ID_SEPARATOR not in raw_name:
        return None, raw_name or "file"
    head, _, tail = raw_name.partition(_FILE_ID_SEPARATOR)
    if not head.startswith(FILE_ID_PREFIX):
        return None, raw_name
    return head, tail or "file"


@dataclass(frozen=True, slots=True)
class OpenCodeTurnAttachment:
    file_id: str
    name: str
    path: str
    media_type: str
    byte_size: int

    def to_part(self) -> dict[str, object]:
        # Embed the platform fileId in ``filename`` so the timeline mapper can
        # recover it after opencode inlines the ``file://`` URL as ``data:``.
        # See ``_FILE_ID_SEPARATOR`` rationale.
        encoded_name = (
            f"{self.file_id}{_FILE_ID_SEPARATOR}{self.name}"
            if self.file_id and _FILE_ID_SEPARATOR not in self.file_id
            else self.name
        )
        return {
            "type": "file",
            "mime": self.media_type,
            "filename": encoded_name,
            "url": file_url(self.path),
        }


async def materialize_opencode_attachments(
    host: RuntimeHostClient,
    session_id: str,
    attachments: tuple[RuntimeAttachment, ...],
) -> tuple[OpenCodeTurnAttachment, ...]:
    """Download platform attachments and stage them for opencode prompts.

    A failed download is logged and skipped: losing one attachment must not
    fail the whole turn.
    """

    materialized: list[OpenCodeTurnAttachment] = []
    for attachment in attachments:
        try:
            downloaded = await host.attachment_download(session_id, attachment.file_id)
        except Exception:  # noqa: BLE001
            logger.exception(
                "opencode attachment download failed file_id={}", attachment.file_id
            )
            continue
        name = downloaded.name or attachment.name or attachment.file_id
        directory = session_attachments_dir(session_id) / safe_component(
            attachment.file_id, "file"
        )
        target = directory / safe_component(name, "file")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(downloaded.content)
        materialized.append(
            OpenCodeTurnAttachment(
                file_id=attachment.file_id,
                name=name,
                path=str(target),
                media_type=resolve_media_type(
                    name,
                    downloaded.media_type or attachment.media_type,
                    downloaded.content[:_TEXT_SNIFF_BYTES],
                ),
                byte_size=len(downloaded.content),
            )
        )
    return tuple(materialized)