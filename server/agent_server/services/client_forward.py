"""Forward client API requests to the device that serves them (``Client/call``, ``Client/subscribe``).

docs/v3/14-unified-client-path.md §B and §C. One client request becomes one ``aa.device.v1.Client/call``: the
route's table entry (``core.client_routes``), the path and body the client sent, who sent it, the facts only the
Server owns (``ClientServerFacts``) and, for a command route, its receipt identity. The device answers with a
head (the HTTP status, how it settled the command) and the body in chunks; the Server joins them, settles the
receipt and checks the body against the route's response model.

* Errors follow ``CLIENT_ERROR_RULES``: not delivered -> the route's offline answer or 409 ``connector_offline``
  (the receipt is dropped); opened then lost -> 504 (``device_read_timeout`` / ``command_outcome_unknown``, the
  receipt becomes ``unknown``); ``resource_exhausted`` -> 503 ``device_busy`` (retryable, the receipt is
  dropped); a body over ``MAX_REQUEST_BODY_BYTES`` -> 413 before anything is sent; an answer that does not match
  the route's response model -> 502 ``device_response_invalid``.
* Receipts (``origin = "client"``): registered under ``input_digest(route, body)`` before the call. A replay of an
  accepted command is forwarded again with the same id (the device's inbox replays its ack, nothing runs twice);
  of a rejected one returns the stored error; of a pending or unknown one asks ``Commands/status`` first and
  answers 504 when it is still unknown. The same id with another input is 409 ``command_conflict``.
* Every device-served route of a device-meshcall device goes through here; there is no other path.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from loguru import logger
from pydantic import BaseModel, ValidationError

from agent_server.core.client_routes import (
    CLIENT_ERROR_RULES,
    CLIENT_MESH_CASES,
    COMMAND_ID_FIELDS,
    CREATE_TIMEOUT_SECONDS,
    GENERATED_COMMAND_ID,
    LONG_TIMEOUT_SECONDS,
    MAX_CHUNK_BYTES,
    MAX_REQUEST_BODY_BYTES,
    MAX_RESPONSE_BYTES,
    ROUTES_BY_ID,
    ClientErrorOutcome,
    ClientFailureCase,
    ClientRoute,
    device_code_status,
)
from agent_server.core.device_meshcall import (
    REQUEST_METHODS,
    ClientCallChunk,
    ClientCaller,
    ClientCallHead,
    ClientCallItem,
    ClientCallRequest,
    ClientCommand,
    ClientServerFacts,
    ClientSubscribeRequest,
    TerminalStreamItem,
)
from agent_server.infra.device_link import DeviceLinkHub
from agent_server.infra.device_mesh import DeviceCallError, DeviceMesh
from agent_server.services.device_commands import DeviceCommandService, input_digest


class ClientForwardError(Exception):
    """An error the Server answers itself (the device's own errors are passed through as ``ClientAnswer``)."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        retryable: bool = False,
        extra: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.retryable = retryable
        self.extra = dict(extra or {})

    def detail(self) -> dict[str, Any]:
        detail: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.retryable:
            detail["retryable"] = True
        detail.update(self.extra)
        return detail


@dataclass(frozen=True, slots=True)
class CommandInfo:
    command_id: str
    #: The id was already registered: this answer comes from the device's inbox, not a new execution.
    replayed: bool
    outcome: str | None = None


@dataclass(slots=True)
class ClientAnswer:
    """What the client gets: the device's status and body, or the Server's offline answer."""

    status: int
    body: Any
    content_type: str = "application/json"
    command: CommandInfo | None = None
    offline: bool = False
    #: The body after the route's response model checked it (``None`` without a model or for an error).
    model: BaseModel | None = field(default=None, repr=False)

    @property
    def ok(self) -> bool:
        return self.status < 400


def client_input_digest(route_id: str, body: Any) -> str:
    """The receipt digest of a forwarded command: the route and the body the device gets."""

    return input_digest(route_id, body if isinstance(body, dict) else {"body": body})


def generated_command_id() -> str:
    return f"c_{uuid.uuid4().hex}"


def command_identity(route: ClientRoute, body: Any) -> tuple[str | None, Any]:
    """The route's command id and the body to forward (with a generated id written into it when the route takes
    its id from a body field the client left out)."""

    if route.command_id is None:
        return None, body
    if route.command_id == GENERATED_COMMAND_ID:
        return generated_command_id(), body
    assert route.command_id in COMMAND_ID_FIELDS
    payload = dict(body) if isinstance(body, dict) else {}
    value = payload.get(route.command_id)
    if isinstance(value, str) and value:
        return value, payload
    command_id = generated_command_id()
    payload[route.command_id] = command_id
    return command_id, payload


def _is_read(route: ClientRoute) -> bool:
    return route.kind == "read" or route.method == "GET"


def _rule(case: ClientFailureCase, route: ClientRoute) -> ClientErrorOutcome:
    for rule in CLIENT_ERROR_RULES:
        if rule.case == case:
            return rule.read if _is_read(route) else rule.command
    raise KeyError(case)


_MESSAGES: dict[str, str] = {
    "connector_offline": "the device is offline",
    "device_read_timeout": "the device did not answer in time",
    "command_outcome_unknown": "the device did not confirm the command",
    "device_busy": "the device is busy; retry shortly",
    "request_too_large": f"the request body is larger than {MAX_REQUEST_BODY_BYTES} bytes",
    "device_response_invalid": "the device answered an invalid body",
}


def _failure(case: ClientFailureCase, route: ClientRoute, message: str | None = None) -> ClientForwardError:
    outcome = _rule(case, route)
    assert outcome.status is not None and outcome.code is not None
    return ClientForwardError(
        outcome.status, outcome.code, message or _MESSAGES.get(outcome.code, outcome.code), retryable=outcome.retryable
    )


def _device_error_body(code: str, message: str) -> dict[str, Any]:
    return {"detail": {"code": code, "message": message or code}}


def _error_code(body: Any) -> str | None:
    if isinstance(body, dict):
        detail = body.get("detail")
        if isinstance(detail, dict) and isinstance(detail.get("code"), str):
            return detail["code"]
    return None


class ResponseTooLarge(ValueError):
    """The answer exceeds ``MAX_RESPONSE_BYTES``."""


def _join_body(head: ClientCallHead, chunks: list[ClientCallChunk]) -> Any:
    """The answer's body from its chunks; raises ``ValueError`` when the chunks break the contract."""

    if not chunks:
        return None
    ordered = sorted(chunks, key=lambda chunk: chunk.seq)
    total = 0
    pieces: list[str] = []
    objects: list[dict[str, Any]] = []
    for chunk in ordered:
        part = chunk.chunk
        size = len(part.encode()) if isinstance(part, str) else len(json.dumps(part, separators=(",", ":")).encode())
        if size > MAX_CHUNK_BYTES:
            raise ValueError(f"a chunk of {size} bytes exceeds {MAX_CHUNK_BYTES}")
        total += size
        if total > MAX_RESPONSE_BYTES:
            raise ResponseTooLarge(f"the answer exceeds {MAX_RESPONSE_BYTES} bytes")
        if isinstance(part, str):
            pieces.append(part)
        else:
            objects.append(part)
    if objects and pieces:
        raise ValueError("an answer mixes text and object chunks")
    if objects:
        if len(objects) != 1:
            raise ValueError("an answer has more than one object chunk")
        return objects[0]
    text = "".join(pieces)
    if "json" not in head.contentType:
        return text
    return json.loads(text) if text else None


@dataclass(slots=True)
class _Flight:
    """One shared device read and how many callers wait for it."""

    task: asyncio.Task[ClientAnswer]
    waiters: int = 0


class ClientForwarder:
    """Turns a client request into ``Client/call`` and the device's answer into the client's response.

    Concurrent identical reads (same caller, device, route, path and query; a ``GET`` without Server facts) share one
    ``Client/call`` in this worker: several clients opening one session cost the device one read. The shared
    ``ClientAnswer`` is read-only for its callers.
    """

    def __init__(
        self,
        mesh: DeviceMesh,
        hub: DeviceLinkHub,
        commands: DeviceCommandService,
    ) -> None:
        self._mesh = mesh
        self._hub = hub
        self._commands = commands
        self._flights: dict[tuple[Any, ...], _Flight] = {}

    def timeout(self, route: ClientRoute) -> float:
        if route.timeout == "create":
            return CREATE_TIMEOUT_SECONDS
        if route.timeout == "long":
            return LONG_TIMEOUT_SECONDS
        if route.timeout == "command":
            return self._mesh.settings.command_timeout_seconds
        return self._mesh.settings.read_timeout_seconds

    # -- Client/call ------------------------------------------------------------------

    async def call(
        self,
        route_id: str,
        *,
        user_id: str,
        device_id: str,
        path: str,
        caller: ClientCaller,
        query: Mapping[str, str] | None = None,
        body: Any = None,
        server: ClientServerFacts | None = None,
        response_model: type[BaseModel] | None = None,
        offline: Callable[[], Awaitable[Any]] | None = None,
        session_id: str | None = None,
        command_id: str | None = None,
        timeout: float | None = None,
        byte_budget: int | None = None,
    ) -> ClientAnswer:
        """Forward one request. Raises ``ClientForwardError`` for what the Server answers itself; the device's own
        answers, errors included, come back as ``ClientAnswer``.

        ``offline``: the route's offline answer (``ClientRoute.offline``), awaited when the call never reached the
        device. ``command_id``: the command id when the caller already took it from the body.
        """

        route = ROUTES_BY_ID[route_id]
        if route.via != "call":
            raise ValueError(f"{route_id} is not forwarded with Client/call")
        if route.method == "GET" and route.command_id is None and server is None and body is None:
            key = (
                user_id, device_id, route.id, path, tuple(sorted((query or {}).items())),
                response_model, byte_budget, timeout,
            )
            return await self._shared(
                key,
                lambda: self._call(
                    route, user_id=user_id, device_id=device_id, path=path, caller=caller, query=query, body=None,
                    server=None, response_model=response_model, offline=offline, session_id=session_id,
                    command_id=None, timeout=timeout, byte_budget=byte_budget,
                ),
            )
        return await self._call(
            route, user_id=user_id, device_id=device_id, path=path, caller=caller, query=query, body=body,
            server=server, response_model=response_model, offline=offline, session_id=session_id,
            command_id=command_id, timeout=timeout, byte_budget=byte_budget,
        )

    async def _shared(self, key: tuple[Any, ...], work: Callable[[], Awaitable[ClientAnswer]]) -> ClientAnswer:
        """Run ``work`` once for every concurrent caller with the same ``key``.

        A caller that is cancelled stops waiting without failing the others; the call is cancelled only once nobody
        waits for it any more.
        """

        flight = self._flights.get(key)
        if flight is None:
            flight = _Flight(asyncio.create_task(work(), name=f"client-call-{key[2]}"))
            self._flights[key] = flight
            flight.task.add_done_callback(lambda task, key=key, flight=flight: self._land(key, flight, task))
        flight.waiters += 1
        try:
            return await asyncio.shield(flight.task)
        finally:
            flight.waiters -= 1
            if flight.waiters == 0 and not flight.task.done():
                self._drop(key, flight)
                flight.task.cancel()

    def _drop(self, key: tuple[Any, ...], flight: _Flight) -> None:
        if self._flights.get(key) is flight:
            del self._flights[key]

    def _land(self, key: tuple[Any, ...], flight: _Flight, task: asyncio.Task[ClientAnswer]) -> None:
        self._drop(key, flight)
        if not task.cancelled():
            task.exception()  # observed here: the waiters re-raise it, and none may be left

    async def _call(
        self,
        route: ClientRoute,
        *,
        user_id: str,
        device_id: str,
        path: str,
        caller: ClientCaller,
        query: Mapping[str, str] | None,
        body: Any,
        server: ClientServerFacts | None,
        response_model: type[BaseModel] | None,
        offline: Callable[[], Awaitable[Any]] | None,
        session_id: str | None,
        command_id: str | None,
        timeout: float | None,
        byte_budget: int | None,
    ) -> ClientAnswer:
        if command_id is None:
            command_id, body = command_identity(route, body)
        if body is not None and len(json.dumps(body, separators=(",", ":"), default=str).encode()) > MAX_REQUEST_BODY_BYTES:
            raise _failure("request_too_large", route)

        receipt: dict[str, Any] | None = None
        replayed = False
        if command_id is not None:
            receipt, created = await self._commands.register(
                origin="client",
                user_id=user_id,
                device_id=device_id,
                command_id=command_id,
                kind=route.id,
                input_digest=client_input_digest(route.id, body),
                session_id=session_id,
            )
            if not created:
                receipt = await self._replayable(receipt, route=route, device_id=device_id, body=body)
                replayed = True

        connection_id = await self._hub.current_connection(device_id)
        if connection_id is None:
            return await self._not_delivered(route, receipt, offline)
        timeout = timeout or self.timeout(route)
        command = None
        if receipt is not None:
            deadline = datetime.now(UTC) + timedelta(seconds=timeout)
            command = ClientCommand(
                commandId=receipt["commandId"], inputDigest=receipt["inputDigest"], deadline=deadline.isoformat()
            )
        request = ClientCallRequest(
            route=route.id,
            method=route.method,  # type: ignore[arg-type]
            path=path,
            query=dict(query or {}),
            body=body,
            caller=caller,
            command=command,
            server=server,
            byteBudget=byte_budget,
        )
        head: ClientCallHead | None = None
        chunks: list[ClientCallChunk] = []
        try:
            async for item in self._mesh.stream(
                device_id,
                REQUEST_METHODS["client.call"],
                request,
                ClientCallItem,
                connection_id=connection_id,
                timeout=timeout,
            ):
                part = item.root
                if isinstance(part, ClientCallHead):
                    if head is not None:
                        raise ValueError("the answer has two heads")
                    head = part
                elif head is None:
                    raise ValueError("a chunk arrived before the head")
                else:
                    chunks.append(part)
                    if part.end:
                        break
        except DeviceCallError as exc:
            return await self._call_failed(exc, route, receipt, offline, replayed=replayed)
        except ValueError as exc:
            await self._settle_unanswered(receipt)
            raise _failure("response_invalid", route, f"the device broke the Client/call stream: {exc}") from exc
        if head is None:
            await self._settle_unanswered(receipt)
            raise _failure("response_invalid", route, "the device answered without a head")
        return await self._answered(route, head, chunks, receipt, response_model, replayed=replayed)

    async def _answered(
        self,
        route: ClientRoute,
        head: ClientCallHead,
        chunks: list[ClientCallChunk],
        receipt: dict[str, Any] | None,
        response_model: type[BaseModel] | None,
        *,
        replayed: bool,
    ) -> ClientAnswer:
        body_error: Exception | None = None
        try:
            body = _join_body(head, chunks)
        except ValueError as exc:
            body, body_error = None, exc
        info = await self._settle_answer(receipt, head, body, replayed=replayed)
        if isinstance(body_error, ResponseTooLarge):
            raise _failure("response_too_large", route, str(body_error))
        if body_error is not None:
            raise _failure("response_invalid", route, f"the device answered an invalid body: {body_error}")
        answer = ClientAnswer(status=head.status, body=body, content_type=head.contentType, command=info)
        if response_model is not None:
            self.check(route.id, answer, response_model)
        return answer

    def check(self, route_id: str, answer: ClientAnswer, response_model: type[BaseModel]) -> None:
        """Validate a successful answer against the route's response model (502 ``device_response_invalid``)."""

        if not answer.ok or answer.offline:
            return
        try:
            answer.model = response_model.model_validate(answer.body)
        except ValidationError as exc:
            # Locations and messages only: the input is conversation content (D1).
            errors = [
                {"loc": error["loc"], "msg": error["msg"]}
                for error in exc.errors(include_url=False, include_input=False)[:3]
            ]
            logger.warning("device answer does not match the route's response model route={} errors={}", route_id, errors)
            raise _failure(
                "response_invalid", ROUTES_BY_ID[route_id], f"the device answered an invalid body: {errors}"
            ) from exc

    async def _settle_answer(
        self, receipt: dict[str, Any] | None, head: ClientCallHead, body: Any, *, replayed: bool
    ) -> CommandInfo | None:
        if receipt is None:
            return None
        if head.command is not None:
            if head.command.commandId != receipt["commandId"]:
                logger.warning(
                    "device settled another command id expected={} got={}", receipt["commandId"], head.command.commandId
                )
            outcome = head.command.outcome
            error = head.command.e.model_dump(mode="json") if head.command.e is not None else None
        elif head.status >= 500:
            # The device failed without saying whether the command ran: unknown until ``Commands/status`` knows.
            unknown = await self._commands.settle(receipt, "unknown", None, only_from=("pending",))
            settled = await self._commands.reconcile_one(unknown or receipt, settle_unseen=False)
            state = (settled or unknown or receipt)["state"]
            return CommandInfo(command_id=receipt["commandId"], replayed=replayed, outcome=state)
        else:
            # The device refused the request before its inbox (it settles those itself; this is the fallback).
            outcome = "accepted" if head.status < 400 else "rejected"
            error = {"code": _error_code(body) or "command_rejected"} if outcome == "rejected" else None
        if outcome == "rejected" and error is None:
            error = {"code": _error_code(body) or "command_rejected"}
        await self._commands.settle(receipt, outcome, {"e": error} if error else None)
        return CommandInfo(command_id=receipt["commandId"], replayed=replayed, outcome=outcome)

    async def _settle_unanswered(self, receipt: dict[str, Any] | None) -> None:
        """The device's stream broke the contract after it may have run the command: the outcome is unknown."""

        if receipt is not None:
            await self._commands.settle(receipt, "unknown", None, only_from=("pending",))

    async def _not_delivered(
        self,
        route: ClientRoute,
        receipt: dict[str, Any] | None,
        offline: Callable[[], Awaitable[Any]] | None,
    ) -> ClientAnswer:
        rule = _rule("not_delivered", route)
        if receipt is not None and rule.receipt == "delete":
            await self._commands.forget(receipt)
        if rule.offlineAnswer and route.offline and offline is not None:
            return ClientAnswer(status=200, body=await offline(), offline=True)
        raise _failure("not_delivered", route)

    async def _call_failed(
        self,
        exc: DeviceCallError,
        route: ClientRoute,
        receipt: dict[str, Any] | None,
        offline: Callable[[], Awaitable[Any]] | None,
        *,
        replayed: bool,
    ) -> ClientAnswer:
        case: ClientFailureCase | None = CLIENT_MESH_CASES.get(exc.code)
        if case is None and exc.not_delivered:
            case = "not_delivered"
        if case is None and exc.outcome_unknown:
            case = "outcome_unknown"
        if case == "not_delivered":
            return await self._not_delivered(route, receipt, offline)
        if case is not None:
            rule = _rule(case, route)
            if receipt is not None:
                if rule.receipt == "delete":
                    await self._commands.forget(receipt)
                elif rule.receipt == "unknown":
                    await self._commands.settle(receipt, "unknown", None, only_from=("pending",))
            raise _failure(case, route, exc.message or None) from exc
        # The device refused the call with its own error before answering a head: its code decides the status.
        aa_code = exc.details.get("aaCode") if isinstance(exc.details, dict) else None
        code = aa_code if isinstance(aa_code, str) and aa_code else exc.code
        info = None
        if receipt is not None:
            await self._commands.settle(receipt, "rejected", {"e": {"code": code, "message": exc.message}})
            info = CommandInfo(command_id=receipt["commandId"], replayed=replayed, outcome="rejected")
        return ClientAnswer(
            status=device_code_status(code), body=_device_error_body(code, exc.message), command=info
        )

    async def _replayable(
        self, receipt: dict[str, Any], *, route: ClientRoute, device_id: str, body: Any
    ) -> dict[str, Any]:
        """A repeated command id: the receipt to forward again with, or the error the replay answers."""

        digest = client_input_digest(route.id, body)
        if (
            receipt.get("origin") != "client"
            or receipt["kind"] != route.id
            or receipt["deviceId"] != device_id
            or (receipt["inputDigest"] and receipt["inputDigest"] != digest)
        ):
            raise ClientForwardError(409, "command_conflict", "this command id was already used for a different command")
        if receipt["state"] in ("pending", "unknown"):
            receipt = await self._commands.reconcile_one(receipt, settle_unseen=False) or receipt
        if receipt["state"] in ("pending", "unknown"):
            # Still not known: never sent again while it may be running.
            raise _failure("outcome_unknown", route, "the device has not confirmed this command yet")
        if receipt["state"] == "rejected":
            error = (receipt.get("result") or {}).get("e") or {}
            code = str(error.get("code") or "command_rejected")
            raise ClientForwardError(
                device_code_status(code), code, str(error.get("message") or "the device rejected this command")
            )
        return receipt

    # -- Client/subscribe ----------------------------------------------------------------

    async def subscribe_terminal(
        self,
        *,
        device_id: str,
        terminal_id: str,
        from_seq: int = 0,
        caller: ClientCaller | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        """The terminal's WebSocket messages (``replay``, ``output``, ``exit``) until it exits or the caller stops.

        Raises ``ClientForwardError``: 409 ``connector_offline`` when the subscription never reached the device,
        504 ``device_read_timeout`` when it broke after it opened, the device's own code otherwise.
        """

        route = ROUTES_BY_ID["connector.terminals.stream"]
        connection_id = await self._hub.current_connection(device_id)
        if connection_id is None:
            raise _failure("not_delivered", route)
        stream = self._mesh.stream(
            device_id,
            REQUEST_METHODS["client.subscribe"],
            ClientSubscribeRequest(stream="terminal", terminalId=terminal_id, fromSeq=max(0, from_seq), caller=caller),
            TerminalStreamItem,
            connection_id=connection_id,
        )
        try:
            async for item in stream:
                yield item.model_dump(mode="json", exclude_none=True)
                if item.type == "exit":
                    return
        except DeviceCallError as exc:
            case = CLIENT_MESH_CASES.get(exc.code)
            if case is None and exc.not_delivered:
                case = "not_delivered"
            if case is None and exc.outcome_unknown:
                case = "outcome_unknown"
            if case is not None:
                raise _failure(case, route, exc.message or None) from exc
            aa_code = exc.details.get("aaCode") if isinstance(exc.details, dict) else None
            code = aa_code if isinstance(aa_code, str) and aa_code else exc.code
            raise ClientForwardError(device_code_status(code), code, exc.message or code) from exc
        finally:
            aclose = getattr(stream, "aclose", None)
            if aclose is not None:
                with contextlib.suppress(Exception):
                    await aclose()
