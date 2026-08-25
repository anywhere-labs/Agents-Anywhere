from __future__ import annotations

import os
import sys
import unicodedata
from pathlib import Path


def canonical_path(path: str | Path) -> str:
    """Return an absolute operational path with resolvable symlinks collapsed."""

    return os.path.normcase(str(Path(path).expanduser().resolve(strict=False)))


def filesystem_resource_key(path: str | Path) -> str:
    """Return a stable lexical identity for an exclusive filesystem resource.

    Darwin resource keys are conservatively case-insensitive and Unicode
    canonical-equivalent. This works before the final path exists and avoids
    mutating the filesystem to probe volume behavior. Symlinks are collapsed by
    ``canonical_path``; unrelated mount aliases remain distinct lexical keys.
    """

    value = canonical_path(path)
    if sys.platform == "darwin":
        value = unicodedata.normalize("NFC", value.casefold())
    return value
