from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from agent_server.core.protocol import (
    PROTOCOL_VERSION_1,
    PlanningRequest,
    PlanningState,
    PlanningResponse,
    PlanDocument,
    ProtocolCapabilitiesResponse,
    ProtocolCapabilitySet,
    ProtocolEventEnvelope,
    ProtocolEventRecoveryResponse,
    ProtocolHandshakeRequest,
    ProtocolHandshakeResponse,
    ProtocolModelCatalog,
    ProtocolModelCatalogResponse,
    ProtocolPermissionCatalog,
    ProtocolPermissionCatalogResponse,
    ProtocolSessionSnapshotResponse,
    ProtocolWsTicketRequest,
    ProtocolWsTicketResponse,
)


JSON_SCHEMA_DRAFT = "https://json-schema.org/draft/2020-12/schema"
SCHEMA_ID_PREFIX = "urn:agents-anywhere:protocol"

SchemaDirection = Literal["ingress", "egress", "bidirectional"]
SchemaMode = Literal["validation", "serialization"]


@dataclass(frozen=True)
class ProtocolSchema:
    slug: str
    model: type[BaseModel]
    direction: SchemaDirection
    mode: SchemaMode


SCHEMAS = (
    ProtocolSchema("planning-request", PlanningRequest, "bidirectional", "validation"),
    ProtocolSchema("planning-state", PlanningState, "egress", "serialization"),
    ProtocolSchema("planning-response", PlanningResponse, "egress", "serialization"),
    ProtocolSchema("plan-document", PlanDocument, "egress", "serialization"),
    ProtocolSchema("handshake-request", ProtocolHandshakeRequest, "ingress", "validation"),
    ProtocolSchema("handshake-response", ProtocolHandshakeResponse, "egress", "serialization"),
    ProtocolSchema("capability-set", ProtocolCapabilitySet, "bidirectional", "validation"),
    ProtocolSchema("capabilities-response", ProtocolCapabilitiesResponse, "egress", "serialization"),
    ProtocolSchema("model-catalog", ProtocolModelCatalog, "bidirectional", "validation"),
    ProtocolSchema("model-catalog-response", ProtocolModelCatalogResponse, "egress", "serialization"),
    ProtocolSchema("permission-catalog", ProtocolPermissionCatalog, "bidirectional", "validation"),
    ProtocolSchema(
        "permission-catalog-response",
        ProtocolPermissionCatalogResponse,
        "egress",
        "serialization",
    ),
    ProtocolSchema(
        "session-snapshot-response",
        ProtocolSessionSnapshotResponse,
        "egress",
        "serialization",
    ),
    ProtocolSchema("ws-ticket-request", ProtocolWsTicketRequest, "ingress", "validation"),
    ProtocolSchema("ws-ticket-response", ProtocolWsTicketResponse, "egress", "serialization"),
    ProtocolSchema("event-envelope", ProtocolEventEnvelope, "egress", "serialization"),
    ProtocolSchema(
        "event-recovery-response",
        ProtocolEventRecoveryResponse,
        "egress",
        "serialization",
    ),
)


def _json_bytes(value: object) -> bytes:
    return (
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode()


def _schema_document(artifact: ProtocolSchema, version: str = "1.0") -> dict[str, object]:
    schema = artifact.model.model_json_schema(by_alias=True, mode=artifact.mode)
    def project(value):
        if isinstance(value, dict):
            if version == "1.0" and value.get("enum") == ["1.0", "1.1"]:
                value.pop("enum"); value["const"] = "1.0"
            if version == "1.1" and value.get("enum") == ["codex", "claude", "opencode", "acp", "dsh"]:
                value.pop("enum"); value["pattern"] = r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$"
            for child in value.values(): project(child)
        elif isinstance(value, list):
            for child in value: project(child)
    project(schema)
    schema["$schema"] = JSON_SCHEMA_DRAFT
    schema["$id"] = (
        f"{SCHEMA_ID_PREFIX}:{version}:{artifact.slug}"
    )
    schema["x-protocol-version"] = version
    schema["x-direction"] = artifact.direction
    schema["x-pydantic-mode"] = artifact.mode
    return schema


def export_contract(output_dir: Path, version: str = "1.0") -> None:
    schema_dir = output_dir / "schemas"
    schema_dir.mkdir(parents=True, exist_ok=True)
    artifacts: list[dict[str, str]] = []

    for artifact in SCHEMAS:
        relative_path = f"schemas/{artifact.slug}.schema.json"
        schema_bytes = _json_bytes(_schema_document(artifact, version))
        (output_dir / relative_path).write_bytes(schema_bytes)
        artifacts.append(
            {
                "direction": artifact.direction,
                "model": artifact.model.__name__,
                "path": relative_path,
                "pydanticMode": artifact.mode,
                "sha256": hashlib.sha256(schema_bytes).hexdigest(),
                "slug": artifact.slug,
            }
        )

    manifest = {
        "artifacts": artifacts,
        "jsonSchemaDraft": JSON_SCHEMA_DRAFT,
        "protocolVersion": version,
        "source": "server/agent_server/core/protocol.py",
    }
    (output_dir / "manifest.json").write_bytes(_json_bytes(manifest))


def main() -> None:
    repository_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(
        description="Export the canonical Agents Anywhere protocol JSON Schemas."
    )
    parser.add_argument("--version", choices=["1.0", "1.1"], default="1.0")
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
    )
    args = parser.parse_args()
    export_contract((args.output or repository_root / "contracts" / "protocol" / args.version).resolve(), args.version)


if __name__ == "__main__":
    main()
