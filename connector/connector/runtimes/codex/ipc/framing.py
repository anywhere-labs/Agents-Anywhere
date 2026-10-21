"""Length-prefixed JSON frames used on the Codex IPC socket.

Every message is ``uint32 little-endian payload length`` followed by UTF-8 JSON.
A zero length or a length above :data:`MAX_FRAME_BYTES` is a protocol error and
the sender's socket must be dropped, matching the extension's reader.
"""

from __future__ import annotations

import json
import struct
from collections.abc import Mapping
from typing import Any

MAX_FRAME_BYTES = 256 * 1024 * 1024
_HEADER = struct.Struct("<I")


class IpcFrameError(ValueError):
    """Raised when an incoming frame violates the IPC framing rules."""


def encode_frame(message: Mapping[str, Any]) -> bytes:
    payload = json.dumps(message, ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    if len(payload) > MAX_FRAME_BYTES:
        raise IpcFrameError(f"frame payload too large ({len(payload)} bytes)")
    return _HEADER.pack(len(payload)) + payload


class FrameDecoder:
    """Incremental decoder that turns a byte stream into JSON messages."""

    __slots__ = ("_buffer",)

    def __init__(self) -> None:
        self._buffer = bytearray()

    def feed(self, data: bytes) -> list[dict[str, Any]]:
        if data:
            self._buffer.extend(data)
        messages: list[dict[str, Any]] = []
        while len(self._buffer) >= _HEADER.size:
            (length,) = _HEADER.unpack_from(self._buffer, 0)
            if length == 0 or length > MAX_FRAME_BYTES:
                raise IpcFrameError(f"invalid frame length ({length} bytes)")
            end = _HEADER.size + length
            if len(self._buffer) < end:
                break
            payload = bytes(self._buffer[_HEADER.size : end])
            del self._buffer[:end]
            try:
                message = json.loads(payload.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise IpcFrameError(f"invalid frame payload: {exc}") from exc
            if not isinstance(message, dict):
                raise IpcFrameError("frame payload must be a JSON object")
            messages.append(message)
        return messages

    def reset(self) -> None:
        self._buffer.clear()
