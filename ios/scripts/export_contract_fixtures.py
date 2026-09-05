"""Generate iOS test payloads from this checkout's backend models; no server needed."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "server"))

from agent_server.core import device_runtime as d
from agent_server.core import models as m
from agent_server.core import protocol as p

NOW = "2026-09-05T12:00:00Z"


def fixtures() -> dict:
    connector = m.ConnectorView(id="device", userId="account", name="Mac", deviceOs="macos", status="online", createdAt=NOW, updatedAt=NOW)
    session = m.SessionView(id="session", connectorId="device", connectorStatus="online", runtime="claude", runtimeId="rti_work", runtimeName="Work", status="idle", takeover=True, title="Task", cwd="/workspace", updatedSeq=10)
    state = m.SessionRuntimeState(sessionId="session", runtime="claude", runtimeId="rti_work", status="idle", selections={"model": "sel_model", "effort": None}, updatedSeq=10, createdAt=NOW, updatedAt=NOW)
    capabilities = p.ProtocolCapabilitySet(revision=10, capabilities=[p.ProtocolCapability(capabilityId="session.send_message", runtime="claude", runtimeId="rti_work")])
    model = p.ProtocolModelCatalog(runtime="claude", revision=1, models=[p.ProtocolModelItem(id="model", displayName="Model", selectionId="sel_model", reasoningItems=[p.ProtocolReasoningItem(id="high", displayName="High", selectionId="sel_effort")])])
    permission = p.ProtocolPermissionCatalog(runtime="claude", revision=1, permissions=[p.ProtocolPermissionItem(id="default", displayName="Default", selectionId="sel_permission")])
    notice = m.NoticeIn(noticeId="notice", type="interaction", sessionId="session", title="Approve", responseRequired=True, actions=[m.NoticeAction(actionId="approve", label="Approve")])
    item = m.TimelineItem(id="item", sessionId="session", type="message", status="done", role="assistant", content={"text": "Hello"}, source={"runtime": "claude"}, orderSeq=1, updatedSeq=10, contentHash="hash", createdAt=NOW, updatedAt=NOW)
    runtime = d.DeviceRuntimeView(connectorId="device", runtimeId="rti_work", runtimeType="claude", name="Work", displayName="Work", typeDisplayName="Claude", present=True, available=True, reason=None, configured=True, active=True, status="running", discovery={}, schema={"type": "object", "properties": {}}, uiSchema={}, defaults={}, capabilities={}, config={}, error=None, lastDiscoveredAt=NOW, createdAt=NOW, updatedAt=NOW)
    runtime_type = d.RuntimeTypeView(connectorId="device", runtimeType="claude", implementationType="claude_sdk", displayName="Claude", description=None, present=True, available=True, reason=None, recommended=True, recommendationRank=1, discovery={}, schema={"type": "object", "properties": {}}, uiSchema={}, defaults={}, capabilities={}, metadata={}, instancePolicy="multiple", maxInstances=3, lastDiscoveredAt=NOW, createdAt=NOW, updatedAt=NOW)
    snapshot = p.ProtocolSessionSnapshotResponse(session=session.model_dump(), state=state.model_dump(), timeline=p.ProtocolTimelineSnapshot(items=[item], nextSeq=10), notices=[notice], effectiveCapabilities=capabilities, runtimeCapabilities=capabilities, catalogs={"model": model.model_dump(), "permission": permission.model_dump()}, eventCursor="seq:10", serverTime=NOW)
    event = p.ProtocolEventEnvelope(eventId="event", sequence=11, cursor="seq:11", type="timeline.item_created", sessionId="session", emittedAt=NOW, payload={"item": item.model_copy(update={"id": "item-2", "orderSeq": 2, "updatedSeq": 11}).model_dump()})
    output = {
        "connector": m.ConnectorResponse(connector=connector, serverTime=NOW),
        "connectors": m.ConnectorListResponse(connectors=[connector], serverTime=NOW),
        "runtime": runtime,
        "runtimes": d.DeviceRuntimeListResponse(connectorId="device", runtimes=[runtime], serverTime=NOW),
        "runtimeTypes": d.RuntimeTypeListResponse(connectorId="device", runtimeTypes=[runtime_type], serverTime=NOW),
        "preferences": m.ConnectorPreferencesResponse(connectorId="device", preferences={"cwd": "/workspace"}, serverTime=NOW),
        "session": m.SessionResponse(session=session, serverTime=NOW),
        "sessions": {"sessions": [session.model_dump()], "serverTime": NOW},
        "takeover": m.TakeoverResponse(session=session),
        "snapshot": snapshot,
        "state": m.SessionRuntimeStateResponse(state=state, serverTime=NOW),
        "capabilities": p.ProtocolCapabilitiesResponse(connectorId="device", capabilitySet=capabilities, serverTime=NOW),
        "modelCatalog": p.ProtocolModelCatalogResponse(catalog=model, serverTime=NOW),
        "permissionCatalog": p.ProtocolPermissionCatalogResponse(catalog=permission, serverTime=NOW),
        "notices": m.RuntimeNoticeListResponse(notices=[notice], serverTime=NOW),
        "commands": m.RuntimeCommandListResponse(commands=[m.RuntimeCommandView(id="plan", title="Plan", acceptsArgs=True, argsSchema={"type": "array"})], serverTime=NOW),
        "timeline": p.ProtocolTimelineResponse(sessionId="session", items=[item], nextSeq=10, hasMore=False, serverTime=NOW),
        "event": event,
        "recovery": p.ProtocolEventRecoveryResponse(events=[event], nextCursor="seq:11", serverTime=NOW),
        "ticket": p.ProtocolWsTicketResponse(ticket="test-ticket", expiresAt=NOW, serverTime=NOW),
        "rpc": m.RpcResponsePayload(ok=True, result={"accepted": True}),
        "rpcError": m.RpcResponsePayload(ok=False, error=m.RpcError(code="notice_not_found", message="Notice expired")),
        "files": m.RpcResponsePayload(ok=True, result={"path": "/workspace", "entries": [{"name": "test.txt", "path": "test.txt", "type": "file", "size": 5}], "truncated": False}),
        "text": m.FsReadTextResponse(path="test.txt", name="test.txt", size=5, sha256="hash", encoding="utf8", content="Hello", truncated=False, binary=False, serverTime=NOW),
        "upload": m.UserUploadResponse(attachments=[m.UploadedAttachment(fileId="file", sessionId="session", name="test.txt", size=5, sha256="hash", mediaType="text/plain", createdAt=NOW, downloadUrl="/api/v2/sessions/session/attachments/file", openUrl="/api/v2/sessions/session/attachments/file/open")], serverTime=NOW),
        "download": m.FsDownloadResponse(fileId="file", sessionId="session", path="test.txt", name="test.txt", size=5, sha256="hash", contentBase64="SGVsbG8=", createdAt=NOW, serverTime=NOW),
        "authConfig": m.AuthConfigResponse(needsBootstrap=False, registrationOpen=True, serverTime=NOW),
        "profile": m.AuthMeResponse(userId="account", email="test@example.com", displayName="Test", role="member", disabled=False, serverTime=NOW),
    }
    result = {key: value.model_dump(mode="json", by_alias=True) if hasattr(value, "model_dump") else value for key, value in output.items()}
    result["dashboard"] = {"type": "dashboard.snapshot", "connectors": [connector.model_dump()], "sessions": [session.model_dump()], "serverTime": NOW}
    requests = {
        "createRuntime": d.RuntimeInstanceCreateRequest(runtimeType="claude", name="Work", config={}, active=True),
        "renameRuntime": d.RuntimeInstancePatchRequest(name="Work"),
        "createSession": m.SessionCreateAndStartRequest(connectorId="device", runtime="claude", runtimeId="rti_work", content="Hello", selections={"model": "sel_model"}),
        "bindSession": m.SessionCreateRequest(connectorId="device", runtime="claude", runtimeId="rti_work", externalSessionId="external", selections={}),
        "selection": m.SessionSelectionPatchRequest(selections={"effort": None}),
        "message": m.MessageCreateRequest(content="Hello", attachments=[], clientMessageId="client"),
        "steer": m.SessionSteerRequest(content="Hello", attachments=[], clientMessageId="client"),
        "command": m.SessionCommandRequest(command="plan", args=["task"], raw="/plan task"),
        "notice": m.InteractionRespondRequest(actionId="approve", input={"confirmed": True}),
        "ticket": p.ProtocolWsTicketRequest(clientId="client", scope=p.ProtocolWsTicketScope(sessionId="session")),
        "readText": m.FsReadTextRequest(path="test.txt"),
    }
    result["requests"] = {key: value.model_dump(mode="json", by_alias=True, exclude_none=True) for key, value in requests.items()}
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = ROOT / "ios/Tests/ClientCoreTests/Fixtures/backend.json"
    content = json.dumps(fixtures(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.check:
        if not target.exists() or target.read_text() != content:
            raise SystemExit("iOS fixtures differ from the current backend; regenerate and review the contract changes.")
        print("Backend contract fixtures are current.")
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        print(f"Wrote {target.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
