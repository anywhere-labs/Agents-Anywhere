"""Command registrations for the E2EE ``required`` mode (docs/v3/11-e2ee-noise.md §4.5, §10).

In required mode a command (send message, approve, plan, goal, settings…) travels inside the secure channel and
the Server cannot read it. Before sending it the client registers ``{commandId, deviceId, inputDigest}`` in
plaintext, so the Server still answers "was this command already sent, and how did it end" across reconnects
and clients:

* the same ``commandId`` with the same digest is a retry: the stored registration (and outcome) is returned;
* the same ``commandId`` with another digest or device is a conflict (``command_conflict``), as in normal mode;
* the device reports the outcome through its outbox (``command.result``, scrubbed of content); the first
  report wins.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol

from agent_server.core.e2ee import CommandRegistration
from agent_server.core.utc import utc_now

#: Registrations are kept long enough for any client retry; the outcome is also in the device's own log.
REGISTRATION_RETENTION = timedelta(days=7)

CommandOutcome = Literal["accepted", "rejected"]


class E2eeCommandRepository(Protocol):
    async def get_connector(self, connector_id: str) -> Any: ...

    async def register_e2ee_command(
        self, *, command_id: str, user_id: str, device_id: str, input_digest: str, now: str
    ) -> tuple[dict[str, Any], bool]: ...

    async def get_e2ee_command(self, command_id: str) -> dict[str, Any] | None: ...

    async def finish_e2ee_command(
        self, *, command_id: str, device_id: str, outcome: str, error_code: str | None, now: str
    ) -> dict[str, Any] | None: ...

    async def prune_e2ee_commands(self, *, device_id: str, before: str) -> int: ...


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


def _public(row: dict[str, Any], *, duplicate: bool) -> dict[str, Any]:
    view = {key: value for key, value in row.items() if key != "userId"}
    view["duplicate"] = duplicate
    return view


class E2eeCommandService:
    def __init__(self, repository: E2eeCommandRepository) -> None:
        self._repository = repository

    async def register(self, user_id: str, registration: CommandRegistration) -> dict[str, Any]:
        await self._owned_device(user_id, registration.deviceId)
        now = utc_now()
        row, created = await self._repository.register_e2ee_command(
            command_id=registration.commandId,
            user_id=user_id,
            device_id=registration.deviceId,
            input_digest=registration.inputDigest,
            now=now,
        )
        if not created:
            # Another user's id must look the same as a digest mismatch: no probing of foreign ids.
            if (
                row["userId"] != user_id
                or row["deviceId"] != registration.deviceId
                or row["inputDigest"] != registration.inputDigest
            ):
                raise E2eeCommandConflict("commandId was already registered with a different input")
            return _public(row, duplicate=True)
        before = (datetime.fromisoformat(now) - REGISTRATION_RETENTION).astimezone(UTC)
        await self._repository.prune_e2ee_commands(
            device_id=registration.deviceId,
            before=before.isoformat().replace("+00:00", "Z"),
        )
        return _public(row, duplicate=False)

    async def status(self, user_id: str, command_id: str) -> dict[str, Any]:
        row = await self._repository.get_e2ee_command(command_id)
        if row is None or row["userId"] != user_id:
            raise E2eeCommandNotFound("command not found")
        return _public(row, duplicate=False)

    async def record_result(
        self,
        device_id: str,
        command_id: str,
        outcome: CommandOutcome,
        error_code: str | None = None,
    ) -> dict[str, Any] | None:
        """Called when the device's outbox reports ``command.result`` for an encrypted command. Unknown ids are
        ignored (``None``): normal-mode commands use their own receipts."""

        return await self._repository.finish_e2ee_command(
            command_id=command_id,
            device_id=device_id,
            outcome=outcome,
            error_code=error_code if outcome == "rejected" else None,
            now=utc_now(),
        )

    async def _owned_device(self, user_id: str, device_id: str) -> None:
        try:
            connector = await self._repository.get_connector(device_id)
        except KeyError:
            raise E2eeCommandNotFound("device not found") from None
        if getattr(connector, "userId", None) != user_id:
            raise E2eeCommandNotFound("device not found")
