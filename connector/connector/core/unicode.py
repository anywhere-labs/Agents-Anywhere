"""Lone UTF-16 surrogates in JSON text.

JavaScript strings may hold a lone surrogate (half of an emoji cut by a
streaming chunk, or garbage in a tool result); ``JSON.stringify`` keeps it as a
``\\udXXX`` escape and the DSH plugin hashes that text. Python's JSON parser
turns the escape back into a lone surrogate code point, which UTF-8 cannot
encode. These helpers keep hashes comparable with the plugin and keep every
byte that leaves the Connector encodable.
"""

from __future__ import annotations

import codecs
import re
from collections.abc import Mapping
from typing import Any

REPLACEMENT = "�"
_LONE_SURROGATE = re.compile("[\ud800-\udfff]")

# Error handler name for ``str.encode("utf-8", errors=...)``: a lone surrogate
# becomes U+FFFD instead of raising.
UTF8_REPLACE_LONE_SURROGATES = "aa-replace-lone-surrogates"


def escape_lone_surrogates(text: str) -> str:
    """Write lone surrogates as ``\\udXXX`` the way ``JSON.stringify`` does."""

    return _LONE_SURROGATE.sub(lambda match: f"\\u{ord(match.group()):04x}", text)


def replace_lone_surrogates(value: Any) -> Any:
    """Replace lone surrogates with U+FFFD in every string of a JSON-like value."""

    if isinstance(value, str):
        return _LONE_SURROGATE.sub(REPLACEMENT, value) if _LONE_SURROGATE.search(value) else value
    if isinstance(value, Mapping):
        return {replace_lone_surrogates(key): replace_lone_surrogates(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [replace_lone_surrogates(item) for item in value]
    return value


def _replace_on_encode(error: UnicodeError) -> tuple[bytes, int]:
    # The UTF-8 encoder only accepts ASCII text from a handler; bytes go in as-is.
    if isinstance(error, UnicodeEncodeError):
        return REPLACEMENT.encode("utf-8"), error.end
    raise error


codecs.register_error(UTF8_REPLACE_LONE_SURROGATES, _replace_on_encode)
