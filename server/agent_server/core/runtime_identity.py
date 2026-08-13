from __future__ import annotations

import re
import unicodedata
from typing import Annotated

from pydantic import StringConstraints

RuntimeId = Annotated[
    str,
    StringConstraints(
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
    ),
]
RuntimeTypeId = Annotated[
    str,
    StringConstraints(
        min_length=1,
        max_length=64,
        pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$",
    ),
]

_WHITESPACE_RE = re.compile(r"\s+")


def normalize_runtime_instance_name(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).strip()
    normalized = _WHITESPACE_RE.sub(" ", normalized)
    if not normalized:
        raise ValueError("runtime instance name is required")
    if len(normalized) > 128:
        raise ValueError("runtime instance name is too long")
    return normalized


def runtime_instance_name_key(value: str) -> str:
    return normalize_runtime_instance_name(value).casefold()
