"""Export the v3 contracts (device-meshcall 1.0, e2ee 1.0, preview 1.0, protocol 1.2).

Same chain as ``export_protocol_schemas.py``: Pydantic models in
``agent_server/core`` are the source, JSON Schemas plus a checksummed manifest
land in ``contracts/<name>/<version>/``, and TypeScript is generated from them.
device-meshcall also gets its MeshCall portable contract
(``device.meshcall.json``, input to ``meshcall generate``) and the
MeshCall error mapping (``mesh-errors.json``).

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

from pydantic import BaseModel

from agent_server.core import device_meshcall as dl
from agent_server.core import e2ee, preview
from agent_server.core import protocol as p11
from agent_server.core import protocol_v1_2 as p12

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
        _a("client-snapshot-request", dl.ClientSnapshotRequest),
        _a("store-read-request", dl.StoreReadRequest),
        _a("store-read-response", dl.StoreReadResponse),
        _a("changes-since-request", dl.ChangesSinceRequest),
        _a("changes-since-response", dl.ChangesSinceResponse),
        _a("command-status-request", dl.CommandStatusRequest),
        _a("command-status-response", dl.CommandStatusResponse),
        _a("send-message-command", dl.SendMessageCommand),
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
        _a("directory-key-grant", e2ee.DirectoryKeyGrant),
        _a("client-grant-view", e2ee.ClientGrantView),
        _a("approve-client-request", e2ee.ApproveClientRequest),
        _a("revoke-client-request", e2ee.RevokeClientRequest),
        _a("trust-list-response", e2ee.TrustListResponse),
        _a("client-tunnel-frame", e2ee.ClientTunnelFrame),
        _a("tunnel-request", e2ee.TunnelRequest),
        _a("tunnel-response", e2ee.TunnelResponse),
        _a("tunnel-event", e2ee.TunnelEvent),
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


def _commands() -> tuple[MeshMethod, ...]:
    methods = [
        MeshMethod(
            dl.command_route(name).method,
            f"Command {name}. accepted only after the device committed it; idempotency_key = commandId.",
            dl.CommandCall,
            dl.CommandAck,
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
        "Session reads and per-session change streams.",
        (
            MeshMethod("snapshot", "Client snapshot within a byte budget, in chunks.", dl.ClientSnapshotRequest,
                       output_item=dl.StreamChunk, annotations=RO),
            MeshMethod("watch", "Opening subscribes, cancelling unsubscribes; items are client-shaped changes.",
                       dl.SessionWatchRequest, output_item=dl.ChangesEvent, annotations=RO),
            MeshMethod("notices", "Open notices of a session.", dl.MethodPayload, dl.MethodPayload, annotations=RO),
            MeshMethod("state", "Runtime state of a session.", dl.MethodPayload, dl.MethodPayload, annotations=RO),
            MeshMethod("capabilities", "Effective capabilities of a session.", dl.MethodPayload, dl.MethodPayload,
                       annotations=RO),
            MeshMethod("queue", "Queued deliveries of a session.", dl.MethodPayload, dl.MethodPayload,
                       annotations=RO),
            MeshMethod("creationGet", "Progress of a session creation (critical lane).", dl.MethodPayload,
                       dl.MethodPayload, annotations=RO),
            MeshMethod("workspacePreparationGet", "Progress of a workspace preparation (critical lane).",
                       dl.MethodPayload, dl.MethodPayload, annotations=RO),
        ),
    ),
    (
        "Store",
        "Timeline pages, changes since a cursor, blobs, shares and plan documents.",
        (
            MeshMethod("read", "A page of timeline items.", dl.StoreReadRequest, dl.StoreReadResponse,
                       annotations=RO),
            MeshMethod("changesSince", "Changes after a client cursor.", dl.ChangesSinceRequest,
                       dl.ChangesSinceResponse, annotations=RO),
            MeshMethod("readBlob", "A stored blob in chunks.", dl.MethodPayload, output_item=dl.StreamChunk,
                       annotations=RO),
            MeshMethod("exportShare", "A share export in chunks.", dl.MethodPayload, output_item=dl.StreamChunk,
                       annotations=RO),
            MeshMethod("planDocument", "A plan document.", dl.MethodPayload, dl.MethodPayload, annotations=RO),
        ),
    ),
    (
        "Runtime",
        "Runtime catalogs.",
        (MeshMethod("catalogs", "Model and permission catalogs.", dl.MethodPayload, dl.MethodPayload,
                    annotations=RO),),
    ),
    ("Commands", "State-changing intents with durable receipts.", _commands()),
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
    return {"module": model.__module__, "qualname": model.__name__, "schema": schema}


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
