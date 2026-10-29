from __future__ import annotations
import hashlib
import json
from pathlib import Path
from agent_server.core.runtime_workflows import PrepareWorkspaceRequest, BeginCreationRequest, WorkflowInteractionResponse, WorkflowView


def main() -> None:
    root = Path(__file__).resolve().parents[2] / "contracts/runtime-workflows/1.2"
    (root / "schemas").mkdir(parents=True, exist_ok=True)
    artifacts = []
    for name, model in (("prepare-request", PrepareWorkspaceRequest), ("creation-request", BeginCreationRequest), ("interaction-response", WorkflowInteractionResponse), ("workflow-view", WorkflowView)):
        value = model.model_json_schema()
        value.update({"$schema": "https://json-schema.org/draft/2020-12/schema", "$id": f"urn:agents-anywhere:runtime-workflows:1.2:{name}"})
        content = (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode()
        path = f"schemas/{name}.schema.json"
        (root / path).write_bytes(content)
        artifacts.append({"slug": name, "path": path, "sha256": hashlib.sha256(content).hexdigest()})
    (root / "manifest.json").write_text(json.dumps({"protocolVersion": "1.2", "artifacts": artifacts}, indent=2) + "\n")


if __name__ == "__main__":
    main()
