"""The in-run message queue of sessions on v3 devices lives on the device (``02-domain-model.md`` §5.1).

The Server keeps no queue for these sessions: reads go to ``Sessions/queue``,
changes are ``Commands/sessionQueue*`` with receipts, and the device pushes
``runtime.queue.updated`` on its link, which the Server fans out to the
session's subscribers. New messages enter the queue through
``session.sendMessage`` with ``queue: auto | interrupt``; the device answers
``{delivery: accepted | queued | duplicate}``.
"""

from __future__ import annotations

import secrets
from typing import Any

from agent_server.services.device_commands import (
    DeviceCommandError,
    DeviceCommandService,
)
from agent_server.services.device_reads import DeviceReadService

# Device rejection codes -> HTTP status, matching the v2 queue errors.
QUEUE_ERROR_STATUS = {
    "queue_full": 409,
    "queue_item_not_found": 404,
    "queue_item_sending": 409,
    "queue_order_mismatch": 409,
    "queue_item_invalid": 422,
}


class DeviceQueueError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def empty_queue(session_id: str, *, device_offline: bool) -> dict[str, Any]:
    state: dict[str, Any] = {"sessionId": session_id, "revision": 0, "items": []}
    if device_offline:
        state["deviceOffline"] = True
    return state


class DeviceQueueService:
    def __init__(self, reads: DeviceReadService, commands: DeviceCommandService) -> None:
        self._reads = reads
        self._commands = commands

    async def read(self, device_id: str, session_id: str) -> dict[str, Any]:
        body = await self._reads.read_method(device_id, "session.queue", {"sessionId": session_id})
        if body is None:
            return empty_queue(session_id, device_offline=True)
        body.setdefault("sessionId", session_id)
        body.setdefault("revision", 0)
        body.setdefault("items", [])
        return body

    async def change(
        self, *, user_id: str, device_id: str, session_id: str, kind: str, payload: dict[str, Any]
    ) -> dict[str, Any]:
        """Run ``session.queue.<kind>`` on the device and return the queue after it."""

        try:
            outcome = await self._commands.send(
                user_id=user_id,
                device_id=device_id,
                kind=f"session.queue.{kind}",
                command_id=f"cq_{secrets.token_urlsafe(16)}",
                payload={"sessionId": session_id, **payload},
                session_id=session_id,
            )
        except DeviceCommandError as exc:
            status = QUEUE_ERROR_STATUS.get(exc.code, exc.status)
            raise DeviceQueueError(status, exc.code, exc.message) from exc
        queue = outcome.result.get("queue") if isinstance(outcome.result, dict) else None
        if isinstance(queue, dict):
            return queue
        if isinstance(outcome.result, dict) and "items" in outcome.result:
            return outcome.result
        return await self.read(device_id, session_id)
