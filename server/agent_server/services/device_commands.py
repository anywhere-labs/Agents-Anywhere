"""Command delivery to v3 devices with durable receipts (``device_commands``).

``03-architecture.md`` §3.4 and ``05-server.md`` §4.7:

- Every state-changing call carries a ``commandId`` (the client's
  ``clientMessageId`` / ``operationId`` when it has one) and is recorded before
  it is sent. ``idempotency_key = commandId`` on the MeshCall call.
- Not delivered (the device is not on the Router): the receipt is removed and
  the caller gets ``connector_offline``; nothing reached the device, a retry
  with the same id is a fresh attempt.
- Outcome unknown (the call opened and then timed out or the link dropped): the
  receipt becomes ``unknown`` and the caller gets ``command_outcome_unknown``.
  It is never re-sent automatically.
- ``unknown`` converges: the device reports ``command.result`` through its
  outbox; and when the same ``commandId`` is replayed, or the device comes back
  (``ready``), the Server asks ``Commands/status``, which is read-only.
- A replay with the same ``commandId`` returns the recorded outcome; with a
  different input digest it is a conflict.
- No conversation content is stored (D1): a receipt keeps ``inputDigest`` and the
  payload only of deferrable commands (``DEFERRABLE_COMMANDS``, replayed on
  hello), and of the outcome only the error code. The device's ``r`` goes to the
  caller waiting on the call; a replay returns the outcome with an empty result.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from loguru import logger
from pydantic import ValidationError

from agent_server.core.device_meshcall import (
    REQUEST_METHODS,
    CommandAck,
    CommandCall,
    CommandStatusRequest,
    CommandStatusResponse,
    command_route,
    scrub_for_e2ee,
    validate_command_payload,
)
from agent_server.core.e2ee_settings import E2eeSettings
from agent_server.infra.device_link import DeviceLinkHub
from agent_server.infra.device_mesh import DeviceCallError, DeviceMesh

# How old a ``pending`` receipt must be before the Server treats "the device does not know
# it" as final: younger ones may still be in flight (the command timeout is 30 s).
UNSEEN_PENDING_AGE = timedelta(minutes=2)


class DeviceCommandError(Exception):
    """``status``/``code`` map to the HTTP error the client sees."""

    def __init__(self, status: int, code: str, message: str, *, receipt: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.receipt = receipt


class DeviceCommandOffline(DeviceCommandError):
    def __init__(self, message: str = "the device is offline") -> None:
        super().__init__(409, "connector_offline", message)


class DeviceCommandOutcomeUnknown(DeviceCommandError):
    def __init__(self, receipt: dict[str, Any] | None, message: str = "the device did not confirm the command") -> None:
        super().__init__(504, "command_outcome_unknown", message, receipt=receipt)


class DeviceCommandRejected(DeviceCommandError):
    def __init__(self, code: str, message: str, receipt: dict[str, Any] | None) -> None:
        super().__init__(409, code, message, receipt=receipt)


@dataclass(frozen=True)
class CommandOutcome:
    """``accepted`` with the device's result, possibly replayed from the receipt."""

    command_id: str
    result: dict[str, Any]
    replayed: bool


def _check_payload(kind: str, payload: dict[str, Any]) -> None:
    """The payload must be ``kind``'s request model (``COMMAND_PAYLOADS``). One that is not is refused as the
    device would refuse it (``invalid_argument``), before anything is recorded or sent."""

    try:
        validate_command_payload(kind, payload)
    except ValidationError as exc:
        logger.warning("device command payload does not match its contract kind={} errors={}", kind, exc.errors())
        raise DeviceCommandRejected("invalid_argument", f"{kind}: {exc.errors()[0]['msg']}", None) from exc


def input_digest(kind: str, payload: dict[str, Any]) -> str:
    canonical = json.dumps([kind, payload], ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)
    return "sha256:" + hashlib.sha256(canonical.encode()).hexdigest()


class DeviceCommandService:
    def __init__(
        self,
        store: Any,
        mesh: DeviceMesh,
        hub: DeviceLinkHub,
        *,
        e2ee_settings: Callable[[], E2eeSettings] = E2eeSettings,
    ) -> None:
        self._store = store
        self._mesh = mesh
        self._hub = hub
        self._e2ee_settings = e2ee_settings

    async def send(
        self,
        *,
        user_id: str | None,
        device_id: str,
        kind: str,
        command_id: str,
        payload: dict[str, Any],
        session_id: str | None = None,
        digest: str | None = None,
        timeout: float | None = None,
    ) -> CommandOutcome:
        """Deliver ``kind`` once; raises ``DeviceCommandError`` subclasses."""

        _check_payload(kind, payload)
        digest = digest or input_digest(kind, payload)
        if user_id is None:
            user_id = (await self._store.get_connector(device_id)).userId
        receipt, created = await self._store.record_device_command(
            user_id=user_id,
            command_id=command_id,
            kind=kind,
            device_id=device_id,
            session_id=session_id,
            input_digest=digest,
            payload=payload,
        )
        if not created:
            return await self._replay(receipt, kind=kind, device_id=device_id, digest=digest)
        return await self._deliver(receipt, payload, timeout=timeout)

    async def _deliver(
        self, receipt: dict[str, Any], payload: dict[str, Any], *, timeout: float | None
    ) -> CommandOutcome:
        device_id = receipt["deviceId"]
        command_id = receipt["commandId"]
        connection_id = await self._hub.current_connection(device_id)
        if connection_id is None:
            await self._store.delete_device_command(receipt["userId"], command_id, only_state="pending")
            raise DeviceCommandOffline()
        timeout = timeout or self._mesh.settings.command_timeout_seconds
        deadline = datetime.now(UTC) + timedelta(seconds=timeout)
        try:
            ack = await self._mesh.unary(
                device_id,
                command_route(receipt["kind"]),
                CommandCall(
                    commandId=command_id,
                    deadline=deadline.isoformat(),
                    inputDigest=receipt["inputDigest"],
                    p=payload,
                ),
                CommandAck,
                connection_id=connection_id,
                timeout=timeout,
                idempotency_key=command_id,
            )
        except DeviceCallError as exc:
            if exc.not_delivered:
                await self._store.delete_device_command(receipt["userId"], command_id, only_state="pending")
                raise DeviceCommandOffline() from exc
            if exc.outcome_unknown:
                settled = await self._settle(receipt, "unknown", None, only_from=("pending",))
                raise DeviceCommandOutcomeUnknown(settled or receipt, exc.message or "command outcome unknown") from exc
            # The device's own AA code (``details.aaCode``) is what clients understand.
            code = str(exc.details.get("aaCode") or exc.code)
            settled = await self._settle(receipt, "rejected", {"e": {"code": code, "message": exc.message}})
            raise DeviceCommandRejected(code, exc.message or code, settled) from exc
        settled = await self._settle_ack(receipt, ack.outcome, ack.r, ack.e)
        live = {"r": ack.r, "e": ack.e.model_dump(mode="json") if ack.e is not None else None}
        if self._e2ee_settings().required:
            live = scrub_for_e2ee("command.ack", live, command=receipt["kind"])
        return self._finish(receipt, settled, replayed=False, live=live)

    async def _replay(self, receipt: dict[str, Any], *, kind: str, device_id: str, digest: str) -> CommandOutcome:
        if receipt["kind"] != kind or receipt["deviceId"] != device_id or (
            receipt["inputDigest"] and receipt["inputDigest"] != digest
        ):
            raise DeviceCommandError(
                409, "command_conflict", "this commandId was already used for a different command", receipt=receipt
            )
        if receipt["state"] in ("pending", "unknown"):
            receipt = await self.reconcile_one(receipt, settle_unseen=False) or receipt
        if receipt["state"] in ("pending", "unknown"):
            # Still not known: report it as unknown again; never re-send.
            raise DeviceCommandOutcomeUnknown(receipt)
        return self._finish(receipt, receipt, replayed=True)

    def _finish(
        self,
        original: dict[str, Any],
        receipt: dict[str, Any] | None,
        *,
        replayed: bool,
        live: dict[str, Any] | None = None,
    ) -> CommandOutcome:
        """``live``: the ``CommandAck`` this call received; the receipt never stores ``r``."""

        receipt = receipt or original
        result = live or receipt.get("result") or {}
        if receipt["state"] == "rejected":
            error = result.get("e") or (receipt.get("result") or {}).get("e") or {}
            raise DeviceCommandRejected(
                str(error.get("code") or "command_rejected"),
                str(error.get("message") or "the device rejected the command"),
                receipt,
            )
        return CommandOutcome(command_id=receipt["commandId"], result=result.get("r") or {}, replayed=replayed)

    async def _settle_ack(
        self, receipt: dict[str, Any], outcome: str, r: dict[str, Any] | None, e: Any
    ) -> dict[str, Any] | None:
        error = e.model_dump(mode="json") if hasattr(e, "model_dump") else e
        settled = await self._settle(receipt, outcome, {"r": r, "e": error})
        if settled is None:
            # Settled meanwhile (outbox ``command.result``): the stored terminal state wins.
            settled = await self._store.get_device_command(receipt["userId"], receipt["commandId"])
        return settled

    async def _settle(
        self,
        receipt: dict[str, Any],
        state: str,
        result: dict[str, Any] | None,
        *,
        only_from: tuple[str, ...] = ("pending", "unknown"),
    ) -> dict[str, Any] | None:
        if result is not None and self._e2ee_settings().required:
            # Defence in depth: in required mode a receipt keeps the outcome and error code only.
            result = scrub_for_e2ee("command.result", result, command=receipt["kind"])
        return await self._store.settle_device_command(
            device_id=receipt["deviceId"],
            command_id=receipt["commandId"],
            user_id=receipt["userId"],
            state=state,
            result=result,
            only_from=only_from,
        )

    # -- convergence ---------------------------------------------------------------

    async def reconcile_one(self, receipt: dict[str, Any], *, settle_unseen: bool = True) -> dict[str, Any] | None:
        """Ask the device (read-only) about an unsettled receipt; returns the updated receipt.

        ``settle_unseen``: a ``pending`` receipt the device does not know, and that is old
        enough not to be in flight, becomes ``rejected`` (``command_not_delivered``).
        """

        device_id = receipt["deviceId"]
        connection_id = await self._hub.current_connection(device_id)
        if connection_id is None:
            return None
        try:
            status = await self._mesh.unary(
                device_id,
                REQUEST_METHODS["command.status"],
                CommandStatusRequest(commandId=receipt["commandId"]),
                CommandStatusResponse,
                connection_id=connection_id,
            )
        except DeviceCallError as exc:
            logger.info("command status unavailable command_id={} error={}", receipt["commandId"], exc)
            return None
        if not status.known or status.outcome in (None, "unknown"):
            cutoff = (datetime.now(UTC) - UNSEEN_PENDING_AGE).isoformat()
            if settle_unseen and receipt["state"] == "pending" and not status.known and receipt["createdAt"] < cutoff:
                # The device never saw it and nobody is waiting on it any more.
                return await self._settle(
                    receipt,
                    "rejected",
                    {"e": {"code": "command_not_delivered", "message": "the device never received this command"}},
                    only_from=("pending", "unknown"),
                )
            return None
        return await self._settle(
            receipt,
            status.outcome,
            {"r": status.r, "e": status.e.model_dump(mode="json") if status.e else None},
        )

    async def reconcile_device(self, device_id: str) -> int:
        """After ``ready``: settle what can be settled; returns how many receipts changed."""

        changed = 0
        for receipt in await self._store.unsettled_device_commands(device_id):
            if await self.reconcile_one(receipt) is not None:
                changed += 1
        if changed:
            logger.info("device commands reconciled device_id={} settled={}", device_id, changed)
        return changed
