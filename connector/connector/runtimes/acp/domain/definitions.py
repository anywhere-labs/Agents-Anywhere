from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any


class AcpError(RuntimeError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


class PromptRejectedBeforeDispatch(AcpError):
    """A local adapter refused input before invoking the Agent prompt method."""


def fingerprint(value: Any) -> str:
    return hashlib.sha256(
        json.dumps(
            value,
            sort_keys=True,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode()
    ).hexdigest()


@dataclass(frozen=True)
class AgentProfile:
    id: str
    title: str
    required_guarantees: frozenset[str] = frozenset()
    permission_options: tuple[tuple[str, str], ...] = ()
    runtime_capabilities: tuple[str, ...] = ()


@dataclass(frozen=True)
class LaunchDefinition:
    executable: str
    arguments: tuple[str, ...]
    release_id: str
    environment: tuple[tuple[str, str], ...] = ()


@dataclass(frozen=True)
class Workspace:
    registered_path: str
    canonical_path: str
