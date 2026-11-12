from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

from agent_server.core.runtime_workflows import (
    BeginCreationRequest,
    PrepareWorkspaceRequest,
    WorkflowInteractionResponse,
    WorkflowView,
)
from scripts.export_protocol_schemas import ProtocolSchema, _schema_document


def main() -> None:
    root = Path(__file__).resolve().parents[2] / "contracts/runtime-workflows/1.2"
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    check = parser.parse_args().check
    artifacts = []
    outputs = {}
    for name, model in (("prepare-request", PrepareWorkspaceRequest), ("creation-request", BeginCreationRequest), ("interaction-response", WorkflowInteractionResponse), ("workflow-view", WorkflowView)):
        if model is WorkflowView:
            value = _schema_document(ProtocolSchema(name, model, "egress", "serialization"), "1.1")
            value["x-protocol-version"] = "1.2"
        else:
            value = model.model_json_schema()
        value.update({"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": f"urn:agents-anywhere:runtime-workflows:1.2:{name}"})
        content = (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
        path = f"schemas/{name}.schema.json"
        outputs[path] = content
        artifacts.append({"slug": name, "path": path, "sha256": hashlib.sha256(content).hexdigest()})
    outputs["manifest.json"] = (json.dumps({"protocolVersion": "1.2", "artifacts": artifacts}, indent=2) + "\n").encode()
    stale = []
    for name, content in outputs.items():
        path = root / name
        if check:
            if not path.exists() or path.read_bytes() != content:
                stale.append(name)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    if stale:
        raise SystemExit("Stale runtime workflow contracts: " + ", ".join(stale))


if __name__ == "__main__":
    main()
