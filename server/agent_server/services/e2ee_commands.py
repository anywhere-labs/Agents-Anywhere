"""Command registrations for the E2EE ``required`` mode (docs/v3/11-e2ee-noise.md §4.5, §10).

In required mode a command (send message, approve, plan, goal, settings…) travels inside the secure channel and
the Server cannot read it. Before sending it the client registers ``{commandId, deviceId, inputDigest}`` in
plaintext, so the Server still answers "was this command already sent, and how did it end" across reconnects
and clients:

* the same ``commandId`` with the same digest is a retry: the stored registration (and outcome) is returned;
* the same ``commandId`` with another digest or device is a conflict (``command_conflict``), as in normal mode;
* the device reports the outcome through its outbox (``command.result``, scrubbed of content); the first
  report wins.

The registration is a ``sealed`` receipt of ``DeviceCommandService`` (one table for every origin); this service
keeps the ``/api/v3/e2ee/commands`` shape on top of it.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol

from agent_server.core.e2ee import CommandRegistration
from agent_server.services.device_commands import DeviceCommandService

#: Registrations are kept long enough for any client retry; the outcome is also in the device's own log.
REGISTRATION_RETENTION = timedelta(days=7)
#: ``device_commands.kind`` of a registration: the Server never learns which command it is.
SEALED_KIND = "sealed"

CommandOutcome = Literal["accepted", "rejected"]


class E2eeCommandRepository(Protocol):
    async def get_connector(self, connector_id: str) -> Any: ...

    async def record_device_command(self, **fields: Any) -> tuple[dict[str, Any], bool]: ...

    async def get_sealed_command(self, command_id: str) -> dict[str, Any] | None: ...

    async def get_device_command(self, user_id: str, command_id: str) -> dict[str, Any] | None: ...

    async def settle_device_command(self, **fields: Any) -> dict[str, Any] | None: ...

    async def prune_device_commands(self, *, device_id: str, origin: str, before: str) -> int: ...


class E2eeCommandError(Exception):
    status_code = 400
    code = "invalid_request"

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message

    def detail(self) -> dict[str, str]:
        return {"code": self.code, "message": self.message}


class E2eeCommandNotFound(E2eeCommandError):
    status_code = 404
    code = "not_found"


class E2eeCommandConflict(E2eeCommandError):
    status_code = 409
    code = "command_conflict"


def _public(receipt: dict[str, Any], *, duplicate: bool) -> dict[str, Any]:
    settled = receipt["state"] in ("accepted", "rejected")
    error = (receipt.get("result") or {}).get("e") or {}
    return {
        "commandId": receipt["commandId"],
        "deviceId": receipt["deviceId"],
        "inputDigest": receipt["inputDigest"],
        "registeredAt": receipt["createdAt"],
        "outcome": receipt["state"] if settled else None,
        "errorCode": error.get("code") if receipt["state"] == "rejected" else None,
        "finishedAt": receipt["updatedAt"] if settled else None,
        "duplicate": duplicate,
    }


class E2eeCommandService:
    def __init__(self, repository: E2eeCommandRepository, commands: DeviceCommandService | None = None) -> None:
        self._repository = repository
        self._commands = commands or DeviceCommandService(repository, None, None)

    async def register(self, user_id: str, registration: CommandRegistration) -> dict[str, Any]:
        await self._owned_device(user_id, registration.deviceId)
        receipt, created = await self._commands.register(
            origin="sealed",
            user_id=user_id,
            device_id=registration.deviceId,
            command_id=registration.commandId,
            kind=SEALED_KIND,
            input_digest=registration.inputDigest,
        )
        if not created:
            # Another user's id must look the same as a digest mismatch: no probing of foreign ids.
            if (
                receipt.get("origin") != "sealed"
                or receipt["userId"] != user_id
                or receipt["deviceId"] != registration.deviceId
                or receipt["inputDigest"] != registration.inputDigest
            ):
                raise E2eeCommandConflict("commandId was already registered with a different input")
            return _public(receipt, duplicate=True)
        before = datetime.now(UTC) - REGISTRATION_RETENTION
        await self._repository.prune_device_commands(
            device_id=registration.deviceId, origin="sealed", before=before.isoformat()
        )
        return _public(receipt, duplicate=False)

    async def status(self, user_id: str, command_id: str) -> dict[str, Any]:
        receipt = await self._repository.get_sealed_command(command_id)
        if receipt is None or receipt["userId"] != user_id:
            raise E2eeCommandNotFound("command not found")
        return _public(receipt, duplicate=False)

    async def record_result(
        self,
        device_id: str,
        command_id: str,
        outcome: CommandOutcome,
        error_code: str | None = None,
    ) -> dict[str, Any] | None:
        """Called when the device's outbox reports ``command.result`` for an encrypted command. Unknown ids are
        ignored (``None``); the first report wins."""

        receipt = await self._repository.get_sealed_command(command_id)
        if receipt is None or receipt["deviceId"] != device_id:
            return None
        error = {"code": error_code, "retryable": False} if outcome == "rejected" and error_code else None
        settled = await self._commands.record_result(
            device_id, command_id, outcome, error, user_id=receipt["userId"]
        )
        return _public(settled, duplicate=False) if settled is not None else None

    async def _owned_device(self, user_id: str, device_id: str) -> None:
        try:
            connector = await self._repository.get_connector(device_id)
        except KeyError:
            raise E2eeCommandNotFound("device not found") from None
        if getattr(connector, "userId", None) != user_id:
            raise E2eeCommandNotFound("device not found")
