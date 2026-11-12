"""Runtime-owned workspace preparation and asynchronous creation ports.

These requests do not require an initialized engine or a live SessionNotice.
Wire validation remains owned by the versioned workflow/Bridge contracts.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass(frozen=True, slots=True)
class RuntimeWorkflowRequest:
    operation: Literal[
        "prepare",
        "get_preparation",
        "refresh_preparation",
        "cancel_preparation",
        "respond_preparation",
        "reserve",
        "begin_creation",
        "get_creation",
        "respond_creation",
        "cancel_initialization",
        "get_response",
        "get_tree",
        "select_position",
        "close_session",
        "recover_session",
        "agent_operation",
    ]
    values: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimeWorkflowResult:
    values: Mapping[str, Any] = field(default_factory=dict)
