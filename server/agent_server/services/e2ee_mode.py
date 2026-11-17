"""Applying the deployment's E2EE mode at startup (docs/v3/11-e2ee-noise.md §11).

``off -> required``: the Server clears every plaintext display field at once (the list shows "encrypting until
the device is online"), and from then on the gate refuses plaintext content routes. Devices write their local
policy and sealed envelopes once they connect. ``required -> off`` changes nothing stored: devices and clients
keep requiring encryption until a person relaxes it on that device.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from loguru import logger

from agent_server.core.e2ee_settings import E2eeSettings

SETTING_E2EE_MODE = "e2ee.mode"


class E2eeModeRepository(Protocol):
    async def get_setting(self, key: str, default: str | None = None) -> str | None: ...

    async def set_setting(self, key: str, value: str) -> None: ...

    async def purge_plaintext_session_display(self) -> int: ...


@dataclass(frozen=True, slots=True)
class ModeTransition:
    previous: str | None
    current: str
    purged_sessions: int = 0


async def apply_e2ee_mode(repository: E2eeModeRepository, settings: E2eeSettings) -> ModeTransition:
    """Idempotent; safe to run in every worker. A database seen for the first time counts as ``off`` before."""

    previous = await repository.get_setting(SETTING_E2EE_MODE)
    purged = 0
    if settings.required and previous != "required":
        purged = await repository.purge_plaintext_session_display()
        logger.warning(
            "E2EE required mode enabled (was {}); cleared plaintext display fields of {} sessions",
            previous or "off",
            purged,
        )
    elif not settings.required and previous == "required":
        logger.warning(
            "E2EE mode changed to off; devices and clients that already require encryption keep doing so "
            "until relaxed locally"
        )
    if previous != settings.mode:
        await repository.set_setting(SETTING_E2EE_MODE, settings.mode)
    return ModeTransition(previous=previous, current=settings.mode, purged_sessions=purged)
