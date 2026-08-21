from __future__ import annotations

import base64
import hashlib
import json
from typing import Any


def model_selection_id(
    provider: str,
    model: str,
    effort: str | None,
) -> str:
    if not provider or not model or (effort is not None and not effort):
        raise ValueError("model selection components must not be empty")
    encoded = json.dumps(
        [provider, model, effort],
        ensure_ascii=False,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return "dsh:model:" + _base64url(encoded)


def decode_model_selection_id(selection_id: str) -> tuple[str, str, str | None]:
    raw = _decode_prefixed(selection_id, "dsh:model:")
    try:
        value: Any = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("invalid DSH model selection") from exc
    if (
        not isinstance(value, list)
        or len(value) != 3
        or not isinstance(value[0], str)
        or not value[0]
        or not isinstance(value[1], str)
        or not value[1]
        or (value[2] is not None and (not isinstance(value[2], str) or not value[2]))
    ):
        raise ValueError("invalid DSH model selection")
    if model_selection_id(value[0], value[1], value[2]) != selection_id:
        raise ValueError("DSH model selection is not canonical")
    return value[0], value[1], value[2]


def permission_selection_id(preset: str) -> str:
    if not preset:
        raise ValueError("permission preset must not be empty")
    return "dsh:permission:" + _base64url(preset.encode("utf-8"))


def decode_permission_selection_id(selection_id: str) -> str:
    raw = _decode_prefixed(selection_id, "dsh:permission:")
    try:
        preset = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError("invalid DSH permission selection") from exc
    if not preset or permission_selection_id(preset) != selection_id:
        raise ValueError("invalid DSH permission selection")
    return preset


def timeline_item_id(
    external_session_id: str,
    projection_kind: str,
    business_id: str,
) -> str:
    if not external_session_id or not projection_kind or not business_id:
        raise ValueError("timeline identity components must not be empty")
    digest = hashlib.sha256(
        f"{external_session_id}\0{projection_kind}\0{business_id}".encode("utf-8")
    ).hexdigest()
    return f"dsh_{digest}"


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _decode_prefixed(value: str, prefix: str) -> bytes:
    if not value.startswith(prefix):
        raise ValueError("invalid DSH selection prefix")
    encoded = value[len(prefix) :]
    if not encoded or "=" in encoded:
        raise ValueError("invalid DSH base64url selection")
    try:
        return base64.b64decode(
            encoded + "=" * (-len(encoded) % 4),
            altchars=b"-_",
            validate=True,
        )
    except (ValueError, base64.binascii.Error) as exc:
        raise ValueError("invalid DSH base64url selection") from exc
