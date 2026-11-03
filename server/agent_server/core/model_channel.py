"""Model channels: which channel each runtime uses, and how a switch moves.

A channel is ``native`` (the runtime's own configuration), ``tokens`` (the
linked Tokens Anywhere profile) or the id of an active manual profile. The user
picks one current channel; a runtime may be pinned to another. Each runtime's
switch is a small transaction (see services/model_channels.py) whose states are
listed here so every layer names them the same way.
"""

from __future__ import annotations

import hashlib
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

NATIVE = "native"
TOKENS = "tokens"

APPLIED = "applied"
PENDING = "pending"
WAITING_ONLINE = "waiting_online"
SWITCHING = "switching"
RESTORING = "restoring"
RESTORED = "restored"
FAILED = "failed"
UNSUPPORTED = "unsupported"

# Waiting for dispatch or for the device to come online.
WAITING = (PENDING, WAITING_ONLINE)
# Writing to the runtime; a crash here is resumed from the saved snapshot.
IN_FLIGHT = (SWITCHING, RESTORING)
UNFINISHED = WAITING + IN_FLIGHT
# A failed switch stays put until the user retries or wants another channel.
NEEDS_RETRY = (RESTORED, FAILED)

PREPARING = "preparing"
ACTIVATING = "activating"
VERIFYING = "verifying"


class ChannelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    channel: str = Field(min_length=1, max_length=128)


class RuntimeChannelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # None follows the current channel.
    channel: str | None = Field(default=None, min_length=1, max_length=128)
    confirmNativeGlobal: bool = False


class RetryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    connectorId: str | None = Field(default=None, min_length=1, max_length=128)
    runtimeId: str | None = Field(default=None, min_length=1, max_length=128)


def profile_channel(profile: dict[str, Any]) -> str:
    """The channel a profile stands for."""
    return TOKENS if profile.get("source") == "tokens" else str(profile["id"])


def switch_state(states: list[str]) -> str:
    """``running`` while any runtime is unfinished, ``attention`` if any failed, else ``done``."""
    if any(state in UNFINISHED for state in states):
        return "running"
    if any(state in NEEDS_RETRY for state in states):
        return "attention"
    return "done"


def managed_channel_runtime_id(connector_id: str, runtime_id: str) -> str:
    """Stable per-logical-runtime identity, so retries and aliases cannot share a sibling's instance."""
    identity = hashlib.sha256((connector_id + "\0" + runtime_id).encode()).hexdigest()[:32]
    return "rti_channel_" + identity
