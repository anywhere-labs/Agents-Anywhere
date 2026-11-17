"""Export the v3 contracts (device-meshcall 1.0, e2ee 1.0, preview 1.0, protocol 1.2).

Same chain as ``export_protocol_schemas.py``: Pydantic models in
``agent_server/core`` are the source, JSON Schemas plus a checksummed manifest
land in ``contracts/<name>/<version>/``, and TypeScript is generated from them.
device-meshcall also gets its MeshCall portable contract
(``device.meshcall.json``, input to ``meshcall generate``), the MeshCall
error mapping (``mesh-errors.json``), the business payload of every method
(``payloads.json``), the client route table (``client-routes.json``) and the
errors of a forwarded client route (``client-errors.json``).

Usage::

    PYTHONPATH=server server/.venv/bin/python server/scripts/export_v3_contracts.py [--check]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, create_model

from agent_server.core import client_routes as cr
from agent_server.core import device_meshcall as dl
from agent_server.core import e2ee, preview
from agent_server.core import protocol as p11
from agent_server.core import protocol_v1_2 as p12
from agent_server.core.runtime_workflows import WorkflowState

JSON_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema"

Direction = Literal["ingress", "egress", "bidirectional"]
Mode = Literal["validation", "serialization"]

RUNTIME_ENUM = ["codex", "claude", "opencode", "acp", "dsh"]
RUNTIME_PATTERN = r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$"


@dataclass(frozen=True)
class Artifact:
    slug: str
    model: type[BaseModel]
    direction: Direction
    mode: Mode


@dataclass(frozen=True)
class Contract:
    name: str
    version: str
    source: str
    artifacts: tuple[Artifact, ...]
    carriage: str | None = None


def _a(slug: str, model: type[BaseModel], direction: Direction = "bidirectional") -> Artifact:
    mode: Mode = "serialization" if direction == "egress" else "validation"
    return Artifact(slug, model, direction, mode)


DEVICE_MESHCALL = Contract(
    "device-meshcall",
    dl.DEVICE_MESHCALL_VERSION,
    "server/agent_server/core/device_meshcall.py",
    (
        _a("link-hello", dl.LinkHello),
        _a("link-welcome", dl.LinkWelcome),
        _a("link-ready", dl.LinkReady),
        _a("display-envelope", dl.DisplayEnvelope),
        _a("session-summary", dl.SessionSummary),
        _a("command-call", dl.CommandCall),
        _a("command-ack", dl.CommandAck),
        _a("stream-chunk", dl.StreamChunk),
        _a("link-attach-request", dl.LinkAttachRequest),
        _a("link-attach-item", dl.LinkAttachItem),
        _a("outbox-open-request", dl.OutboxOpenRequest),
        _a("outbox-item", dl.OutboxItem),
        _a("outbox-ack", dl.OutboxAck),
        _a("session-watch-request", dl.SessionWatchRequest),
        _a("secure-channel-open", dl.SecureChannelOpen),
        _a("secure-channel-item", dl.SecureChannelItem),
        _a("changes-event", dl.ChangesEvent),
        _a("runtime-status-event", dl.RuntimeStatusEvent),
        _a("session-summary-out", dl.SessionSummaryOut),
        _a("session-inventory-out", dl.SessionInventoryOut),
        _a("command-result-out", dl.CommandResultOut),
        _a("attachment-consumed-out", dl.AttachmentConsumedOut),
        _a("usage-report-out", dl.UsageReportOut),
        _a("command-status-request", dl.CommandStatusRequest),
        _a("command-status-response", dl.CommandStatusResponse),
        # Events and reads
        _a("runtime-notice-updated-event", dl.RuntimeNoticeUpdatedEvent),
        _a("runtime-queue-updated-event", dl.RuntimeQueueUpdatedEvent),
        _a("preparation-get-request", dl.PreparationGetRequest),
        _a("creation-get-request", dl.CreationGetRequest),
        _a("workflow-state", WorkflowState),
        _a("read-blob-request", dl.ReadBlobRequest),
        _a("read-blob-chunk", dl.ReadBlobChunk),
        _a("export-share-request", dl.ExportShareRequest),
        _a("export-share-chunk", dl.ExportShareChunk),
        # Command payloads and results
        _a("session-command", dl.SessionCommand),
        _a("send-message-command", dl.SendMessageCommand),
        _a("send-message-result", dl.SendMessageResult),
        _a("steer-command", dl.SteerCommand),
        _a("steer-result", dl.SteerResult),
        _a("interrupt-result", dl.InterruptResult),
        _a("respond-notice-command", dl.RespondNoticeCommand),
        _a("respond-notice-result", dl.RespondNoticeResult),
        _a("select-command", dl.SelectCommand),
        _a("select-result", dl.SelectResult),
        _a("creation-begin-command", dl.CreationBeginCommand),
        _a("creation-begin-result", dl.CreationBeginResult),
        _a("creation-respond-command", dl.CreationRespondCommand),
        _a("creation-cancel-command", dl.CreationCancelCommand),
        _a("workspace-prepare-command", dl.WorkspacePrepareCommand),
        _a("preparation-reserve-command", dl.PreparationReserveCommand),
        _a("preparation-reserve-result", dl.PreparationReserveResult),
        _a("preparation-respond-command", dl.PreparationRespondCommand),
        _a("preparation-cancel-command", dl.PreparationCancelCommand),
        _a("session-planning-command", dl.SessionPlanningCommand),
        _a("session-goal-command", dl.SessionGoalCommand),
        _a("queue-item-command", dl.QueueItemCommand),
        _a("queue-reorder-command", dl.QueueReorderCommand),
        _a("queue-result", dl.QueueResult),
        _a("session-sync-command", dl.SessionSyncCommand),
        _a("session-sync-result", dl.SessionSyncResult),
        _a("runtime-apply-command", dl.RuntimeApplyCommand),
        _a("channel-switch-command", dl.ChannelSwitchCommand),
        _a("runtime-apply-result", dl.RuntimeApplyResult),
        _a("device-settings-apply-command", dl.DeviceSettingsApplyCommand),
        _a("device-settings-apply-result", dl.DeviceSettingsApplyResult),
        _a("preview-open-result", dl.PreviewOpenResult),
        _a("preview-close-result", dl.PreviewCloseResult),
        # Client service
        _a("client-call-request", dl.ClientCallRequest),
        _a("client-call-item", dl.ClientCallItem),
        _a("client-subscribe-request", dl.ClientSubscribeRequest),
        _a("terminal-stream-item", dl.TerminalStreamItem),
    ),
    carriage=dl.MESHCALL_PROTOCOL,
)

E2EE = Contract(
    "e2ee",
    e2ee.E2EE_VERSION,
    "server/agent_server/core/e2ee.py",
    (
        _a("pairing-payload", e2ee.PairingPayload),
        _a("handshake-envelope", e2ee.HandshakeEnvelope),
        _a("pairing-device-hello", e2ee.PairingDeviceHello),
        _a("pairing-client-hello", e2ee.PairingClientHello),
        _a("directory-key-grant", e2ee.DirectoryKeyGrant),
        _a("pair-committed", e2ee.PairCommitted),
        _a("channel-ready", e2ee.ChannelReady),
        _a("channel-close", e2ee.ChannelClose),
        _a("client-grant-view", e2ee.ClientGrantView),
        _a("approve-client-request", e2ee.ApproveClientRequest),
        _a("revoke-client-request", e2ee.RevokeClientRequest),
        _a("trust-list-response", e2ee.TrustListResponse),
        _a("client-tunnel-frame", e2ee.ClientTunnelFrame),
        _a("client-tunnel-end", e2ee.ClientTunnelEnd),
        _a("tunnel-request", e2ee.TunnelRequest),
        _a("tunnel-response", e2ee.TunnelResponse),
        _a("tunnel-subscribe", e2ee.TunnelSubscribe),
        _a("tunnel-unsubscribe", e2ee.TunnelUnsubscribe),
        _a("tunnel-event", e2ee.TunnelEvent),
        _a("sealed-attachment-key", e2ee.SealedAttachmentKey),
        _a("tunnel-file-chunk", e2ee.TunnelFileChunk),
        _a("command-registration", e2ee.CommandRegistration, "ingress"),
    ),
)

PREVIEW = Contract(
    "preview",
    preview.PREVIEW_VERSION,
    "server/agent_server/core/preview.py",
    (
        _a("create-preview-request", preview.CreatePreviewRequest, "ingress"),
        _a("preview-view", preview.PreviewView, "egress"),
        _a("preview-list-response", preview.PreviewListResponse, "egress"),
        _a("preview-ticket-response", preview.PreviewTicketResponse, "egress"),
        _a("port-listening-event", preview.PortListeningEvent),
        _a("port-closed-event", preview.PortClosedEvent),
        _a("preview-open-command", preview.PreviewOpenCommand),
        _a("preview-close-command", preview.PreviewCloseCommand),
    ),
)

PROTOCOL_1_2 = Contract(
    "protocol",
    p12.PROTOCOL_VERSION_1_2,
    "server/agent_server/core/protocol.py + protocol_v1_2.py",
    (
        _a("goal-request", p11.GoalRequest),
        _a("goal-state", p11.GoalState, "egress"),
        _a("goal-response", p11.GoalResponse, "egress"),
        _a("planning-request", p11.PlanningRequest),
        _a("planning-state", p11.PlanningState, "egress"),
        _a("planning-response", p11.PlanningResponse, "egress"),
        _a("plan-document", p11.PlanDocument, "egress"),
        _a("handshake-request", p11.ProtocolHandshakeRequest, "ingress"),
        _a("handshake-response", p11.ProtocolHandshakeResponse, "egress"),
        _a("capability-set", p11.ProtocolCapabilitySet),
        _a("capabilities-response", p11.ProtocolCapabilitiesResponse, "egress"),
        _a("model-catalog", p11.ProtocolModelCatalog),
        _a("model-catalog-response", p11.ProtocolModelCatalogResponse, "egress"),
        _a("permission-catalog", p11.ProtocolPermissionCatalog),
        _a("permission-catalog-response", p11.ProtocolPermissionCatalogResponse, "egress"),
        _a("session-snapshot-response", p12.ProtocolSessionSnapshotResponseV12, "egress"),
        _a("timeline-response", p12.ProtocolTimelineResponseV12, "egress"),
        _a("ws-ticket-request", p11.ProtocolWsTicketRequest, "ingress"),
        _a("ws-ticket-response", p11.ProtocolWsTicketResponse, "egress"),
        _a("event-envelope", p11.ProtocolEventEnvelope, "egress"),
        _a("event-recovery-response", p12.ProtocolEventRecoveryResponseV12, "egress"),
        _a("session-catchup-required-payload", p12.SessionCatchupRequiredPayload, "egress"),
        _a("session-queue-state", p12.SessionQueueStateV12, "egress"),
        _a("display-user-update-request", p12.DisplayUserUpdateRequest, "ingress"),
    ),
)

CONTRACTS = (DEVICE_MESHCALL, E2EE, PREVIEW, PROTOCOL_1_2)


# ---------------------------------------------------------------------------
# MeshCall portable contract for device-meshcall
# ---------------------------------------------------------------------------

RO = {"idempotent": True, "read_only": True, "destructive": False}
MUTATES = {"idempotent": True, "read_only": False, "destructive": False}
DUPLEX = {"idempotent": False, "read_only": False, "destructive": False}
ONCE = {"idempotent": False, "read_only": False, "destructive": False}


@dataclass(frozen=True)
class MeshMethod:
    name: str
    description: str
    request: type[BaseModel]
    response: type[BaseModel] | None = None
    output_item: type[BaseModel] | None = None
    input_item: type[BaseModel] | None = None
    annotations: dict[str, bool] | None = None
    duplex_reason: str | None = None

    @property
    def stream(self) -> str:
        if self.input_item is not None:
            return "duplex"
        return "server_stream" if self.output_item is not None else "unary"


def _typed_envelopes(name: str) -> tuple[type[BaseModel], type[BaseModel]]:
    """``CommandCall`` / ``CommandAck`` of one command, with ``p`` and ``r`` typed by ``COMMAND_PAYLOADS``."""

    payloads = dl.COMMAND_PAYLOADS[name]
    route = dl.command_route(name).method
    title = route[:1].upper() + route[1:]
    call = create_model(f"{title}Call", __base__=dl.CommandCall, p=(payloads.request, ...))
    ack = create_model(f"{title}Ack", __base__=dl.CommandAck, r=(payloads.response | None, None))
    call.__doc__ = f"CommandCall of {name}: p is {payloads.request.__name__}."
    ack.__doc__ = f"CommandAck of {name}: r is {payloads.response.__name__}."
    return call, ack


def _commands() -> tuple[MeshMethod, ...]:
    methods = [
        MeshMethod(
            dl.command_route(name).method,
            f"Command {name}. accepted only after the device committed it; idempotency_key = commandId.",
            *_typed_envelopes(name),
            annotations=MUTATES,
        )
        for name in dl.COMMAND_METHODS
    ]
    methods.append(
        MeshMethod("status", "Durable receipt of a command (command.status).", dl.CommandStatusRequest,
                   dl.CommandStatusResponse, annotations=RO)
    )
    return tuple(methods)


MESH_SERVICES: tuple[tuple[str, str, tuple[MeshMethod, ...]], ...] = (
    (
        "Link",
        "Presence, lossy device events and the persistent outbox. The Server opens both streams after /device/ready.",
        (
            MeshMethod("attach", "Heartbeat every 20 s plus lossy events; the open stream is the device's presence.",
                       dl.LinkAttachRequest, output_item=dl.LinkAttachItem, annotations=RO),
            MeshMethod("outbox", "Every open resends unacknowledged outbox messages in oid order.",
                       dl.OutboxOpenRequest, output_item=dl.OutboxItem, annotations=RO),
            MeshMethod("ackOutbox", "Cumulative outbox acknowledgement.", dl.OutboxAck, dl.Empty,
                       annotations=MUTATES),
        ),
    ),
    (
        "Sessions",
        "Per-session change streams and creation progress.",
        (
            MeshMethod("watch", "Opening subscribes, cancelling unsubscribes; items are client-shaped changes.",
                       dl.SessionWatchRequest, output_item=dl.ChangesEvent, annotations=RO),
            MeshMethod("creationGet", "Progress of a session creation (critical lane).", dl.CreationGetRequest,
                       WorkflowState, annotations=RO),
            MeshMethod("workspacePreparationGet", "Progress of a workspace preparation (critical lane).",
                       dl.PreparationGetRequest, WorkflowState, annotations=RO),
        ),
    ),
    (
        "Store",
        "Blobs and share exports.",
        (
            MeshMethod("readBlob", "A stored blob: metadata on the stream, bytes over the transfer relay.",
                       dl.ReadBlobRequest, output_item=dl.ReadBlobChunk, annotations=RO),
            MeshMethod("exportShare", "A share export in chunks.", dl.ExportShareRequest,
                       output_item=dl.ExportShareChunk, annotations=RO),
        ),
    ),
    ("Commands", "State-changing intents with durable receipts.", _commands()),
    (
        "Client",
        "Normal mode only: the client API routes the device serves (client-routes.json), one request per call.",
        (
            MeshMethod("call", "One client API request: a head with the HTTP status, then the body in chunks. "
                       "Commands carry their receipt identity; the device replays by commandId.",
                       dl.ClientCallRequest, output_item=dl.ClientCallItem, annotations=ONCE),
            MeshMethod("subscribe", "Opening subscribes to a terminal, cancelling unsubscribes; items are the "
                       "terminal WebSocket messages.", dl.ClientSubscribeRequest, output_item=dl.TerminalStreamItem,
                       annotations=RO),
        ),
    ),
    (
        "Secure",
        "E2EE required mode only: opaque Noise channels between a client and this device.",
        (
            MeshMethod("channel", "One call per client channel; the Server forwards n/ct without reading them.",
                       dl.SecureChannelOpen, input_item=dl.SecureChannelItem, output_item=dl.SecureChannelItem,
                       annotations=DUPLEX,
                       duplex_reason="Noise transport messages flow both ways, interleaved and in order, "
                       "for the whole life of a client channel."),
        ),
    ),
)


def _model_ref(model: type[BaseModel] | None) -> dict[str, Any] | None:
    if model is None:
        return None
    schema = model.model_json_schema(by_alias=True, mode="validation")
    _project(schema, DEVICE_MESHCALL)
    schema.pop("title", None)
    qualname = model.__name__
    if model.__module__ != dl.__name__ and issubclass(model, (dl.CommandCall, dl.CommandAck)):
        # A typed command envelope: the wire model, with its payload type named.
        base = dl.CommandCall if issubclass(model, dl.CommandCall) else dl.CommandAck
        field = "p" if base is dl.CommandCall else "r"
        annotation = model.model_fields[field].annotation
        payload = next((arg for arg in getattr(annotation, "__args__", ()) if arg is not type(None)), annotation)
        return {"module": dl.__name__, "qualname": f"{base.__name__}[{payload.__name__}]", "schema": schema}
    return {"module": model.__module__, "qualname": qualname, "schema": schema}


def render_mesh_contract() -> dict[str, Any]:
    services = []
    for short, description, methods in MESH_SERVICES:
        name = f"{dl.MESH_SERVICE_PREFIX}.{short}"
        balance = {"kind": "round_robin", "key": None}
        services.append(
            {
                "name": name,
                "version": "1",
                "source_module": "agent_server.core.device_meshcall",
                "source_qualname": f"{short}Service",
                "balance": balance,
                "description": description,
                "targeted": True,
                "methods": [
                    {
                        "name": m.name,
                        "stream": m.stream,
                        "request": _model_ref(m.request),
                        "parameters": sorted(m.request.model_fields),
                        "response": _model_ref(m.response),
                        "input_item": _model_ref(m.input_item),
                        "output_item": _model_ref(m.output_item),
                        "balance": balance,
                        "description": m.description,
                        "annotations": m.annotations or MUTATES,
                        "deprecated": None,
                        "duplex_reason": m.duplex_reason,
                    }
                    for m in methods
                ],
            }
        )
    return {"protocol": dl.MESHCALL_PROTOCOL, "services": services}


def render_mesh_errors() -> dict[str, Any]:
    return {
        "rules": [rule.model_dump() for rule in dl.MESH_ERROR_RULES],
        "beforeOpen": "not_delivered",
        "unmatched": "application",
    }


def _artifact_ref(model: type[BaseModel]) -> dict[str, str]:
    """Where a payload model is published: the contract artifact whose model it is."""

    for contract in CONTRACTS:
        for artifact in contract.artifacts:
            if artifact.model is model:
                return {"contract": contract.name, "version": contract.version, "slug": artifact.slug,
                        "model": model.__name__}
    raise LookupError(f"{model.__name__} is not a contract artifact; add it to a contract")


def render_payloads() -> dict[str, Any]:
    """The business payload of every method: what ``CommandCall.p`` / ``CommandAck.r``, read requests and
    responses, ``LinkAttachItem.p`` and ``OutboxItem.p`` hold, by method."""

    def pair(payloads: dl.MethodPayloads) -> dict[str, Any]:
        return {"request": _artifact_ref(payloads.request), "response": _artifact_ref(payloads.response)}

    reads = {}
    for name, payloads in dl.READ_PAYLOADS.items():
        route = dl.REQUEST_METHODS[name]
        reads[name] = {**pair(payloads), "route": f"{route.service}/{route.method}", "shape": route.shape}
    return {
        "commands": {
            name: {**pair(payloads), "route": f"{dl.MESH_SERVICE_PREFIX}.Commands/{dl.command_route(name).method}"}
            for name, payloads in dl.COMMAND_PAYLOADS.items()
        },
        "reads": reads,
        "events": {name: _artifact_ref(model) for name, model in dl.EVENT_PAYLOADS.items()},
        "outbox": {name: _artifact_ref(model) for name, model in dl.OUTBOX_PAYLOADS.items()},
    }


def render_client_routes() -> dict[str, Any]:
    routes = [
        {
            "id": route.id,
            "method": route.method,
            "path": route.path,
            "owner": route.owner,
            "kind": route.kind,
            "via": route.via,
            "commandId": route.command_id,
            "writesCommandId": route.writes_command_id,
            "timeout": route.timeout,
            "offline": route.offline,
            "decorate": list(route.decorate),
            "e2ee": route.e2ee,
            "sealedUpload": route.sealed_upload,
            "forward": route.forward,
        }
        for route in cr.CLIENT_ROUTES
    ]
    return {
        "routes": routes,
        "families": [{"id": f.id, "prefix": f.prefix, "bare": f.bare} for f in cr.ROUTE_FAMILIES],
        "commandIdFields": list(cr.COMMAND_ID_FIELDS),
        "generatedCommandId": cr.GENERATED_COMMAND_ID,
        "timeoutSeconds": {"read": None, "command": cr.COMMAND_TIMEOUT_SECONDS, "create": cr.CREATE_TIMEOUT_SECONDS},
        "limits": {
            "maxRequestBodyBytes": cr.MAX_REQUEST_BODY_BYTES,
            "maxChunkBytes": cr.MAX_CHUNK_BYTES,
            "maxResponseBytes": cr.MAX_RESPONSE_BYTES,
        },
    }


def render_client_errors() -> dict[str, Any]:
    return {
        "rules": [rule.model_dump() for rule in cr.CLIENT_ERROR_RULES],
        "meshCases": dict(cr.CLIENT_MESH_CASES),
        "deviceCodeStatus": dict(cr.DEVICE_CODE_STATUS),
        "deviceCodeDefaultStatus": cr.DEVICE_CODE_DEFAULT_STATUS,
    }


def render_e2ee_registration() -> dict[str, Any]:
    """What a device registers in each E2EE mode, and which attach events may stay in plaintext."""

    return {
        "modes": {mode: dl.registered_services(mode) for mode in ("off", "required")},
        "attachEvents": {"off": list(dl.EVENT_METHODS), "required": list(dl.E2EE_EVENT_METHODS)},
        "outbox": list(dl.OUTBOX_METHODS),
        "contentFreeInRequired": {
            "command.result": "r is null; e carries only code and retryable",
            "command.ack": "r is null; e carries only code and retryable",
            "command.status": "r is null; e carries only code and retryable",
            "session.summary": "displayDevice is sealed with the current directory key",
            "session.inventory": "every displayDevice is sealed",
            "attachment.consumed": "sha256 is the digest of the stored ciphertext",
            "runtime.status": "status codes only, no free text taken from a session",
        },
    }


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()


def _project(value: Any, contract: Contract) -> None:
    if isinstance(value, dict):
        if value.get("enum") == RUNTIME_ENUM:
            value.pop("enum")
            value["pattern"] = RUNTIME_PATTERN
        if contract.name == "protocol" and value.get("enum") == ["1.0", "1.1"]:
            value["enum"] = ["1.0", "1.1", "1.2"]
        for child in value.values():
            _project(child, contract)
    elif isinstance(value, list):
        for child in value:
            _project(child, contract)


def _schema(contract: Contract, artifact: Artifact) -> dict[str, Any]:
    schema = artifact.model.model_json_schema(by_alias=True, mode=artifact.mode)
    _project(schema, contract)
    schema["$schema"] = JSON_SCHEMA_DRAFT
    schema["$id"] = f"urn:agents-anywhere:{contract.name}:{contract.version}:{artifact.slug}"
    schema["x-contract"] = contract.name
    schema["x-protocol-version"] = contract.version
    schema["x-direction"] = artifact.direction
    schema["x-pydantic-mode"] = artifact.mode
    return schema


def render(contract: Contract) -> dict[str, bytes]:
    files: dict[str, bytes] = {}
    entries: list[dict[str, str]] = []
    for artifact in contract.artifacts:
        rel = f"schemas/{artifact.slug}.schema.json"
        data = _json_bytes(_schema(contract, artifact))
        files[rel] = data
        entries.append(
            {
                "direction": artifact.direction,
                "model": artifact.model.__name__,
                "path": rel,
                "pydanticMode": artifact.mode,
                "sha256": hashlib.sha256(data).hexdigest(),
                "slug": artifact.slug,
            }
        )
    extras: list[dict[str, str]] = []
    if contract is DEVICE_MESHCALL:
        for rel, value in (
            ("device.meshcall.json", render_mesh_contract()),
            ("mesh-errors.json", render_mesh_errors()),
            ("e2ee-registration.json", render_e2ee_registration()),
            ("payloads.json", render_payloads()),
            ("client-routes.json", render_client_routes()),
            ("client-errors.json", render_client_errors()),
        ):
            data = _json_bytes(value)
            files[rel] = data
            extras.append({"path": rel, "sha256": hashlib.sha256(data).hexdigest()})
    manifest: dict[str, Any] = {
        "artifacts": entries,
        "contract": contract.name,
        "jsonSchemaDraft": JSON_SCHEMA_DRAFT,
        "protocolVersion": contract.version,
        "source": contract.source,
    }
    if contract.carriage:
        manifest["carriage"] = contract.carriage
    if extras:
        manifest["extras"] = extras
    files["manifest.json"] = _json_bytes(manifest)
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail if the committed files differ")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2] / "contracts"
    stale: list[str] = []
    for contract in CONTRACTS:
        out = root / contract.name / contract.version
        rendered = render(contract)
        if args.check and (out / "schemas").is_dir():
            for path in sorted((out / "schemas").iterdir()):
                if f"schemas/{path.name}" not in rendered:
                    stale.append(f"{path.relative_to(root.parent)} (not exported)")
        for rel, data in rendered.items():
            path = out / rel
            if args.check:
                if not path.exists() or path.read_bytes() != data:
                    stale.append(str(path.relative_to(root.parent)))
                continue
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    if stale:
        print("stale contract files:\n  " + "\n  ".join(stale), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
