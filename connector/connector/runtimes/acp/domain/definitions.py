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
    release_ready: bool = False
    unavailable_reason: str = "acp_release_acceptance_pending"
    permission_options: tuple[tuple[str, str], ...] = ()
    runtime_capabilities: tuple[str, ...] = ()
    # Release acceptance belongs to the profile, never to the ACP transport.
    required_work_devices: frozenset[str] = frozenset()
    required_clients: frozenset[str] = frozenset()


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


@dataclass(frozen=True)
class ComponentReference:
    release_id: str
    profile_id: str
    platform: str
    architecture: str
