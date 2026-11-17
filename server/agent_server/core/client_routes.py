"""The client API routes a device serves, alone or together with the Server (docs/v3/14-unified-client-path.md).

One table, read by everything that needs to know which client routes reach a device:

* the E2EE gateway (``core.e2ee_settings``): which plaintext routes ``required`` mode refuses;
* the Server forwarder: how a route reaches the device (``via``), which body field carries the
  command id, the timeout, whether an offline device gets a synthesized answer, what the Server
  overlays on the device's answer;
* the device: ``Client/call`` names a route by ``id`` (``ClientRouteId``) and picks its execution lane
  from ``kind``;
* the contracts: ``contracts/device-meshcall/1.0/client-routes.json`` and ``client-errors.json``.

Routes the Server serves alone (accounts, the session directory, device management, model configuration)
are listed only where the E2EE policy needs them (``e2ee`` below).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

HttpMethod = Literal["GET", "POST", "PUT", "PATCH", "DELETE", "WS"]
#: ``server``: the Server answers alone. ``device``: the device answers; the Server checks ownership,
#: admission and usage, and passes facts it owns in ``ClientCallRequest.server``. ``hybrid``: both
#: contribute to one answer (the Server keeps a record, allocates ids or overlays its own view).
RouteOwner = Literal["server", "device", "hybrid"]
#: Execution lane on the device: ``critical`` routes (approvals, notices, interrupts, creation and
#: preparation prompts) never queue behind long reads; ``stream`` routes stay open.
RouteKind = Literal["read", "command", "critical", "stream"]
#: How the Server reaches the device for this route.
#:
#: * ``call``: ``aa.device.v1.Client/call`` with this route's id;
#: * ``subscribe``: ``aa.device.v1.Client/subscribe`` (terminal streams);
#: * ``watch``: ``aa.device.v1.Sessions/watch``, fanned out by the Server;
#: * ``blob``: ``aa.device.v1.Store/readBlob`` through the transfer relay;
#: * ``share``: ``aa.device.v1.Store/exportShare``;
#: * ``workflow``: the typed runtime-workflows commands (``Commands/workspace*``, ``sessionCreation*``);
#: * ``server``: the Server answers; ``forward`` names the route it calls for the device's part, if any;
#: * ``unsupported``: v3 has no carrier; the Server answers 409.
RouteCarrier = Literal["call", "subscribe", "watch", "blob", "share", "workflow", "server", "unsupported"]
#: ``read``: the Server's ``read_timeout_seconds``; ``command``: ``COMMAND_TIMEOUT_SECONDS``;
#: ``create``: ``CREATE_TIMEOUT_SECONDS``.
RouteTimeout = Literal["read", "command", "create"]
#: ``channel``: ``required`` mode refuses the plaintext route (it carries content); ``plain``: allowed.
RouteE2ee = Literal["channel", "plain"]

API = "/api/v2"
SESSION = f"{API}/sessions/{{session_id}}"
CONNECTOR = f"{API}/connectors/{{connector_id}}"
WORKFLOWS = f"{API}/runtime-workflows"

COMMAND_TIMEOUT_SECONDS = 30.0
CREATE_TIMEOUT_SECONDS = 60.0
#: The Server refuses a larger request body with 413 before forwarding it (attachments are uploaded apart).
MAX_REQUEST_BODY_BYTES = 1024 * 1024
#: Largest ``StreamChunk.chunk`` of a ``Client/call`` answer (UTF-8 bytes).
MAX_CHUNK_BYTES = 512 * 1024
#: Largest whole ``Client/call`` answer, the same as one message on the client's channel.
MAX_RESPONSE_BYTES = 16 * 1024 * 1024
#: Body fields a command route may take its command id from, besides the generated ``commandId``.
COMMAND_ID_FIELDS = ("clientMessageId", "responseId", "operationId")
#: The route's command id is generated (``c_…``) and travels only in ``ClientCallRequest.command``.
GENERATED_COMMAND_ID = "commandId"


@dataclass(frozen=True, slots=True)
class ClientRoute:
    id: str
    method: HttpMethod
    path: str
    owner: RouteOwner
    kind: RouteKind
    via: RouteCarrier
    #: Body field holding the command id (``COMMAND_ID_FIELDS``), or ``GENERATED_COMMAND_ID``; None: the
    #: route has no receipt (reads, and workspace commands that are never retried).
    command_id: str | None = None
    timeout: RouteTimeout = "read"
    #: Not delivered: the Server answers 200 with ``deviceOffline: true`` instead of ``connector_offline``.
    offline: bool = False
    #: What the Server overlays on the device's answer.
    decorate: tuple[str, ...] = ()
    e2ee: RouteE2ee = "channel"
    #: The attachment upload: an encrypted upload passes in ``required`` mode.
    sealed_upload: bool = False
    #: ``via == "server"``: the route whose ``Client/call`` answers the device's part.
    forward: str | None = None

    @property
    def writes_command_id(self) -> bool:
        """The Server generates a missing id and writes it into the body before forwarding."""

        return self.command_id in COMMAND_ID_FIELDS

    def pattern(self) -> re.Pattern[str]:
        return re.compile(template_regex(self.path))


@dataclass(frozen=True, slots=True)
class RouteFamily:
    """A path prefix ``required`` mode refuses as a whole, so a route added under it is refused by default.

    ``bare``: the prefix itself is part of the family. Routes under the prefix whose ``e2ee`` is ``plain``
    are the family's exceptions.
    """

    id: str
    prefix: str
    bare: bool


def _route(
    id: str,
    method: HttpMethod,
    path: str,
    owner: RouteOwner,
    kind: RouteKind,
    via: RouteCarrier = "call",
    **options: object,
) -> ClientRoute:
    return ClientRoute(id, method, path, owner, kind, via, **options)  # type: ignore[arg-type]


def _command(id: str, method: HttpMethod, path: str, command_id: str | None, **options: object) -> ClientRoute:
    options.setdefault("timeout", "command")
    return _route(id, method, path, "device", "command", command_id=command_id, **options)


def _read(id: str, path: str, **options: object) -> ClientRoute:
    return _route(id, "GET", path, "device", "read", **options)


CLIENT_ROUTES: tuple[ClientRoute, ...] = (
    # -- sessions: creation ------------------------------------------------------------------------
    _route("session.create", "POST", f"{API}/sessions", "server", "command", "server", timeout="command"),
    _route("session.createAndStart", "POST", f"{API}/sessions/create-and-start", "hybrid", "command",
           command_id="clientMessageId", timeout="create", decorate=("session",)),
    # -- sessions: directory entry (Server-owned, allowed in plaintext) --------------------------------
    _route("session.meta.get", "GET", f"{SESSION}/meta", "server", "read", "server", e2ee="plain"),
    _route("session.meta.update", "PATCH", f"{SESSION}/meta", "server", "command", "server", e2ee="plain"),
    # -- sessions: content reads -----------------------------------------------------------------------
    _route("session.snapshot", "GET", f"{SESSION}/snapshot", "hybrid", "read", offline=True,
           decorate=("session", "catalogs", "effectiveCapabilities")),
    _read("session.timeline", f"{SESSION}/timeline", offline=True),
    _read("session.events", f"{SESSION}/events", offline=True),
    _read("session.runtime.state", f"{SESSION}/runtime/state", offline=True, e2ee="plain"),
    _read("session.runtime.capabilities", f"{SESSION}/runtime/capabilities", offline=True, e2ee="plain"),
    _route("session.runtime.notices", "GET", f"{SESSION}/runtime/notices", "device", "critical"),
    _read("session.runtime.queue", f"{SESSION}/runtime/queue", offline=True),
    _read("session.runtime.commands", f"{SESSION}/runtime/commands"),
    _read("session.runtime.catalogs.model", f"{SESSION}/runtime/catalogs/model", decorate=("channelCatalog",)),
    _read("session.runtime.catalogs.permission", f"{SESSION}/runtime/catalogs/permission"),
    _read("session.planning.get", f"{SESSION}/planning"),
    _read("session.goal.get", f"{SESSION}/goal"),
    _read("session.plans.list", f"{SESSION}/plans"),
    _read("session.plans.get", f"{SESSION}/plans/{{plan_id}}/{{revision}}"),
    _read("session.plans.markdown", f"{SESSION}/plans/{{plan_id}}/{{revision}}/markdown"),
    _route("session.planning.operation", "GET", f"{SESSION}/planning/operations/{{operation_id}}", "hybrid", "read",
           "server", forward="session.planning.get"),
    _route("session.goal.operation", "GET", f"{SESSION}/goal/operations/{{operation_id}}", "hybrid", "read",
           "server", forward="session.goal.get"),
    # -- sessions: commands ------------------------------------------------------------------------------
    _command("session.runtime.messages", "POST", f"{SESSION}/runtime/messages", "clientMessageId"),
    _command("session.runtime.steer", "POST", f"{SESSION}/runtime/steer", "clientMessageId"),
    _route("session.runtime.interrupt", "POST", f"{SESSION}/runtime/interrupt", "device", "critical",
           command_id=GENERATED_COMMAND_ID, timeout="command"),
    _route("session.runtime.notices.respond", "POST", f"{SESSION}/runtime/notices/{{notice_id}}/respond", "device",
           "critical", command_id="responseId", timeout="command"),
    _command("session.runtime.selections", "PATCH", f"{SESSION}/runtime/selections", GENERATED_COMMAND_ID),
    _command("session.runtime.commands.execute", "POST", f"{SESSION}/runtime/commands", "operationId"),
    _command("session.sync", "POST", f"{SESSION}/sync", GENERATED_COMMAND_ID),
    _command("session.planning.execute", "POST", f"{SESSION}/planning", "operationId"),
    _command("session.goal.execute", "POST", f"{SESSION}/goal", "operationId"),
    _command("session.runtime.queue.clear", "DELETE", f"{SESSION}/runtime/queue", GENERATED_COMMAND_ID),
    _command("session.runtime.queue.reorder", "PUT", f"{SESSION}/runtime/queue/order", GENERATED_COMMAND_ID),
    _command("session.runtime.queue.resume", "POST", f"{SESSION}/runtime/queue/resume", GENERATED_COMMAND_ID),
    _command("session.runtime.queue.update", "PATCH", f"{SESSION}/runtime/queue/{{message_id}}", GENERATED_COMMAND_ID),
    _command("session.runtime.queue.delete", "DELETE", f"{SESSION}/runtime/queue/{{message_id}}",
             GENERATED_COMMAND_ID),
    _command("session.runtime.queue.retry", "POST", f"{SESSION}/runtime/queue/{{message_id}}/retry",
             GENERATED_COMMAND_ID),
    _command("session.runtime.queue.sendNow", "POST", f"{SESSION}/runtime/queue/{{message_id}}/send-now",
             GENERATED_COMMAND_ID),
    # -- sessions: realtime, shares and attachments --------------------------------------------------------
    _route("session.ws", "WS", f"{SESSION}/ws", "device", "stream", "watch"),
    _route("session.shares.create", "POST", f"{SESSION}/shares", "hybrid", "command", "share", timeout="command"),
    _route("session.attachments.upload", "POST", f"{SESSION}/attachments", "server", "command", "server",
           timeout="command", sealed_upload=True),
    _route("session.attachments.get", "GET", f"{SESSION}/attachments/{{file_id}}", "hybrid", "read", "blob"),
    _route("session.attachments.open", "GET", f"{SESSION}/attachments/{{file_id}}/open", "hybrid", "read", "blob"),
    _route("session.attachments.thumb", "GET", f"{SESSION}/attachments/{{file_id}}/thumb", "hybrid", "read", "blob"),
    # -- sessions: terminals scoped to a session (aliases of the device terminals) -----------------------------
    _command("session.terminals.create", "POST", f"{SESSION}/terminals", None),
    _read("session.terminals.list", f"{SESSION}/terminals"),
    _command("session.terminals.close", "DELETE", f"{SESSION}/terminals/{{terminal_id}}", None),
    _command("session.terminals.rename", "PATCH", f"{SESSION}/terminals/{{terminal_id}}", None),
    _command("session.terminals.resize", "POST", f"{SESSION}/terminals/{{terminal_id}}/resize", None),
    _route("session.terminals.stream", "WS", f"{SESSION}/terminals/{{terminal_id}}/stream", "device", "stream",
           "subscribe"),
    # -- device files -----------------------------------------------------------------------------------------
    _route("connector.fs.list", "POST", f"{CONNECTOR}/fs/list", "device", "read"),
    _route("connector.fs.readText", "POST", f"{CONNECTOR}/fs/readText", "device", "read"),
    _command("connector.fs.write", "POST", f"{CONNECTOR}/fs/write", None),
    _route("connector.fs.read", "POST", f"{CONNECTOR}/fs/read", "hybrid", "read"),
    _route("connector.fs.transfer", "GET", f"{CONNECTOR}/fs/transfers/{{transfer_id}}", "server", "read", "server"),
    _route("connector.fs.previewToken", "POST", f"{CONNECTOR}/fs/preview-token", "server", "command", "server"),
    _route("connector.fs.previewSession", "POST", f"{API}/connectors/fs/preview-session", "server", "command",
           "server"),
    _route("connector.fs.preview.readText", "POST", f"{API}/connectors/fs/preview/readText", "hybrid", "read",
           "server", forward="connector.fs.readText"),
    _route("connector.fs.preview.read", "POST", f"{API}/connectors/fs/preview/read", "hybrid", "read", "server",
           forward="connector.fs.read"),
    # -- device terminals ---------------------------------------------------------------------------------------
    _command("connector.terminals.create", "POST", f"{CONNECTOR}/terminals-v2", None),
    _read("connector.terminals.list", f"{CONNECTOR}/terminals-v2"),
    _command("connector.terminals.close", "DELETE", f"{CONNECTOR}/terminals-v2/{{terminal_id}}", None),
    _command("connector.terminals.rename", "PATCH", f"{CONNECTOR}/terminals-v2/{{terminal_id}}", None),
    _command("connector.terminals.persistence", "PATCH", f"{CONNECTOR}/terminals-v2/{{terminal_id}}/persistence",
             None),
    _command("connector.terminals.resize", "POST", f"{CONNECTOR}/terminals-v2/{{terminal_id}}/resize", None),
    _command("connector.terminals.write", "POST", f"{CONNECTOR}/terminals-v2/{{terminal_id}}/write", None),
    _read("connector.terminals.snapshot", f"{CONNECTOR}/terminals-v2/{{terminal_id}}/snapshot"),
    _route("connector.terminals.stream", "WS", f"{CONNECTOR}/terminals-v2/{{terminal_id}}/stream", "device", "stream",
           "subscribe"),
    _command("connector.terminalsV1.create", "POST", f"{CONNECTOR}/terminals", None),
    _read("connector.terminalsV1.list", f"{CONNECTOR}/terminals"),
    _command("connector.terminalsV1.close", "DELETE", f"{CONNECTOR}/terminals/{{terminal_id}}", None),
    _command("connector.terminalsV1.rename", "PATCH", f"{CONNECTOR}/terminals/{{terminal_id}}", None),
    _command("connector.terminalsV1.resize", "POST", f"{CONNECTOR}/terminals/{{terminal_id}}/resize", None),
    _route("connector.terminalsV1.stream", "WS", f"{CONNECTOR}/terminals/{{terminal_id}}/stream", "device", "stream",
           "subscribe"),
    # -- device shell ---------------------------------------------------------------------------------------------
    _command("connector.shell.exec", "POST", f"{CONNECTOR}/shell/exec", None),
    _command("connector.shell.tasks.start", "POST", f"{CONNECTOR}/shell/tasks", None, via="unsupported"),
    _route("connector.shell.tasks.wait", "GET", f"{CONNECTOR}/shell/tasks/{{task_id}}/wait", "device", "read",
           "unsupported"),
    # -- runtime catalogs of a device instance (model configuration, allowed in plaintext) ------------------------
    _read("connector.runtime.catalogs.model", f"{CONNECTOR}/runtimes/{{runtime_id}}/catalogs/model",
          decorate=("channelCatalog",), e2ee="plain"),
    _read("connector.runtime.catalogs.permission", f"{CONNECTOR}/runtimes/{{runtime_id}}/catalogs/permission",
          e2ee="plain"),
    _read("connector.runtime.commands", f"{CONNECTOR}/runtimes/{{runtime_id}}/commands", e2ee="plain"),
    # -- runtime workflows: the Server keeps the workflow; the device runs it through typed commands ---------------
    _route("workflow.prepare", "POST", f"{WORKFLOWS}/preparations", "hybrid", "command", "workflow",
           timeout="command"),
    _route("workflow.create", "POST", f"{WORKFLOWS}/creations", "hybrid", "command", "workflow", timeout="create"),
    _route("workflow.get", "GET", f"{WORKFLOWS}/{{kind}}/{{identifier}}", "hybrid", "critical", "workflow"),
    _route("workflow.respond", "POST", f"{WORKFLOWS}/{{kind}}/{{identifier}}/responses", "hybrid", "critical",
           "workflow", timeout="command"),
    _route("workflow.cancel", "POST", f"{WORKFLOWS}/{{kind}}/{{identifier}}/cancel", "hybrid", "critical", "workflow",
           timeout="command"),
    _route("workflow.session.tree", "GET", f"{WORKFLOWS}/sessions/{{session_id}}/tree", "device", "read",
           "unsupported"),
    _route("workflow.session.position", "POST", f"{WORKFLOWS}/sessions/{{session_id}}/position", "device", "command",
           "unsupported"),
    _route("workflow.session.close", "POST", f"{WORKFLOWS}/sessions/{{session_id}}/close", "device", "command",
           "unsupported"),
    _route("workflow.session.configuration.get", "GET", f"{WORKFLOWS}/sessions/{{session_id}}/configuration",
           "device", "read", "unsupported"),
    _route("workflow.session.configuration.update", "POST", f"{WORKFLOWS}/sessions/{{session_id}}/configuration",
           "device", "command", "unsupported"),
    _route("workflow.session.operations", "POST", f"{WORKFLOWS}/sessions/{{session_id}}/operations", "device",
           "command", "unsupported"),
    _route("workflow.session.recover", "POST", f"{WORKFLOWS}/sessions/{{session_id}}/recover", "device", "command",
           "unsupported"),
)

ROUTE_FAMILIES: tuple[RouteFamily, ...] = (
    # Everything under a session except its directory entry and scheduling state (the plain routes below).
    RouteFamily("session", SESSION, bare=False),
    RouteFamily("connector.fs", f"{CONNECTOR}/fs", bare=True),
    RouteFamily("connector.shell", f"{CONNECTOR}/shell", bare=True),
    RouteFamily("connector.terminals", f"{CONNECTOR}/terminals", bare=True),
    RouteFamily("connector.terminalsV2", f"{CONNECTOR}/terminals-v2", bare=True),
    RouteFamily("connector.preview", f"{API}/connectors/fs", bare=False),
    # Workspace preparation, the creation wizard, its answers, session trees and agent operations.
    RouteFamily("workflow", WORKFLOWS, bare=True),
)

ROUTES_BY_ID: dict[str, ClientRoute] = {route.id: route for route in CLIENT_ROUTES}
#: Routes the Server forwards with ``Client/call`` (the values of ``ClientRouteId``).
CLIENT_CALL_ROUTE_IDS: tuple[str, ...] = tuple(route.id for route in CLIENT_ROUTES if route.via == "call")


def template_regex(template: str) -> str:
    """``/sessions/{session_id}/meta`` -> ``/sessions/[^/]+/meta`` (one path segment per parameter)."""

    parts = re.split(r"(\{[a-z_]+\})", template)
    return "".join("[^/]+" if part.startswith("{") else re.escape(part) for part in parts)


def _under(route: ClientRoute, family: RouteFamily) -> bool:
    return route.path.startswith(family.prefix + "/") or (family.bare and route.path == family.prefix)


def _family_regex(family: RouteFamily) -> str:
    prefix = template_regex(family.prefix)
    if family.bare:
        return f"{prefix}(/.*)?"
    exceptions = sorted(
        {template_regex(route.path[len(family.prefix) + 1:]) for route in CLIENT_ROUTES
         if route.e2ee == "plain" and _under(route, family)}
    )
    guard = f"(?!({'|'.join(exceptions)})$)" if exceptions else ""
    return f"{prefix}/{guard}.+"


def content_route_patterns() -> tuple[tuple[str, re.Pattern[str]], ...]:
    """``(method or "*", pattern)`` pairs ``required`` mode refuses: each family, then each content route
    outside every family."""

    patterns: list[tuple[str, re.Pattern[str]]] = [("*", re.compile(_family_regex(f))) for f in ROUTE_FAMILIES]
    for route in CLIENT_ROUTES:
        if route.e2ee == "channel" and not any(_under(route, family) for family in ROUTE_FAMILIES):
            patterns.append((route.method, route.pattern()))
    return tuple(patterns)


def sealed_upload_patterns() -> tuple[re.Pattern[str], ...]:
    return tuple(route.pattern() for route in CLIENT_ROUTES if route.sealed_upload)


def match_route(method: str, path: str) -> ClientRoute | None:
    """The table entry of ``method path`` (``WS`` for a WebSocket), or None."""

    method = method.upper()
    for route in CLIENT_ROUTES:
        if route.method == method and route.pattern().fullmatch(path):
            return route
    return None


def check_table() -> list[str]:
    """Inconsistencies of the table; empty when it is sound (asserted by the tests)."""

    problems: list[str] = []
    seen: set[tuple[str, str]] = set()
    for route in CLIENT_ROUTES:
        key = (route.method, route.path)
        if key in seen:
            problems.append(f"{route.id}: {route.method} {route.path} is listed twice")
        seen.add(key)
        if route.command_id is not None and route.command_id not in (*COMMAND_ID_FIELDS, GENERATED_COMMAND_ID):
            problems.append(f"{route.id}: unknown command id field {route.command_id}")
        if route.command_id is not None and route.kind not in ("command", "critical"):
            problems.append(f"{route.id}: a {route.kind} route has no command id")
        if route.forward is not None and (route.via != "server" or ROUTES_BY_ID.get(route.forward) is None
                                          or ROUTES_BY_ID[route.forward].via != "call"):
            problems.append(f"{route.id}: forward must name a Client/call route")
        if route.offline and route.kind not in ("read", "critical"):
            problems.append(f"{route.id}: only reads have an offline answer")
        if route.e2ee == "plain" and any(_under(route, f) for f in ROUTE_FAMILIES if f.bare):
            problems.append(f"{route.id}: a whole-prefix family cannot have plain routes")
    if len(ROUTES_BY_ID) != len(CLIENT_ROUTES):
        problems.append("route ids are not unique")
    return problems


# ---------------------------------------------------------------------------
# Errors of a forwarded route (``client-errors.json``)
# ---------------------------------------------------------------------------

ClientFailureCase = Literal[
    "device_answered", "not_delivered", "outcome_unknown", "device_busy", "request_too_large", "response_invalid"
]
ReceiptAction = Literal["settle", "delete", "unknown", "none"]


class ClientErrorOutcome(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: int | None = Field(description="HTTP status; null passes the device's status through")
    code: str | None = Field(description="detail.code; null passes the device's body through")
    receipt: ReceiptAction = "none"
    retryable: bool = False
    offlineAnswer: bool = Field(
        default=False, description="routes with an offline answer reply 200 with deviceOffline: true instead"
    )


class ClientErrorRule(BaseModel):
    model_config = ConfigDict(frozen=True)

    case: ClientFailureCase
    description: str
    read: ClientErrorOutcome
    command: ClientErrorOutcome


CLIENT_ERROR_RULES: tuple[ClientErrorRule, ...] = (
    ClientErrorRule(
        case="device_answered",
        description="The device answered with a status and a body.",
        read=ClientErrorOutcome(status=None, code=None),
        command=ClientErrorOutcome(status=None, code=None, receipt="settle"),
    ),
    ClientErrorRule(
        case="not_delivered",
        description="The call never reached the device.",
        read=ClientErrorOutcome(status=409, code="connector_offline", offlineAnswer=True),
        command=ClientErrorOutcome(status=409, code="connector_offline", receipt="delete"),
    ),
    ClientErrorRule(
        case="outcome_unknown",
        description="The call opened, then timed out or the link dropped.",
        read=ClientErrorOutcome(status=504, code="device_read_timeout"),
        command=ClientErrorOutcome(status=504, code="command_outcome_unknown", receipt="unknown"),
    ),
    ClientErrorRule(
        case="device_busy",
        description="The device refused the call: too many calls of its lane in flight (resource_exhausted).",
        read=ClientErrorOutcome(status=503, code="device_busy", retryable=True),
        command=ClientErrorOutcome(status=503, code="device_busy", receipt="delete", retryable=True),
    ),
    ClientErrorRule(
        case="request_too_large",
        description="The request body exceeds MAX_REQUEST_BODY_BYTES; refused before forwarding.",
        read=ClientErrorOutcome(status=413, code="request_too_large"),
        command=ClientErrorOutcome(status=413, code="request_too_large"),
    ),
    ClientErrorRule(
        case="response_invalid",
        description="The device's answer does not match the route's response model.",
        read=ClientErrorOutcome(status=502, code="device_response_invalid"),
        command=ClientErrorOutcome(status=502, code="device_response_invalid", receipt="settle"),
    ),
)

#: MeshCall failures of ``Client/call`` that are not ``classify_mesh_error``'s: ``(code, reason)`` -> case.
CLIENT_MESH_CASES: dict[str, ClientFailureCase] = {"resource_exhausted": "device_busy"}

#: AA error code a device raises -> HTTP status of its answer; anything else is ``DEVICE_CODE_DEFAULT_STATUS``.
DEVICE_CODE_STATUS: dict[str, int] = {
    "session_not_found": 404,
    "not_found": 404,
    "terminal_not_found": 404,
    "file_not_found": 404,
    "plan_document_not_found": 404,
    "queue_item_not_found": 404,
    "invalid_argument": 422,
    "invalid_path": 422,
    "path_not_allowed": 403,
    "permission_denied": 403,
    "precondition_failed": 412,
    "if_match_failed": 412,
    "runtime_unavailable": 503,
    "internal": 500,
}
DEVICE_CODE_DEFAULT_STATUS = 409


def device_code_status(code: str) -> int:
    return DEVICE_CODE_STATUS.get(code, DEVICE_CODE_DEFAULT_STATUS)
