"""Send ONE real turn into a VS Code-owned thread through the IPC follower
protocol (``thread-follower-start-turn``) and record the resulting stream.
This is a WRITE: it makes the owner call turn/start. Use only on a thread you
own and are happy to append to.

Usage: python ipc_start_turn_probe.py --text "..." [--seconds N] conversationId
"""
from __future__ import annotations
import argparse, json, os, sys, time, uuid
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ipc_router_probe import IpcConn, ipc_socket_path, version_for  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--text", required=True)
ap.add_argument("--seconds", type=float, default=60)
ap.add_argument("--out", default="/tmp/codex-ipc-dumps/start-turn.jsonl")
ap.add_argument("cid")
a = ap.parse_args()

c = IpcConn(ipc_socket_path()); r = c.request("initialize", {"clientType": "agents-anywhere"}); c.client_id = r["result"]["clientId"]
r = c.request("thread-owner-discovery", {"hostId": "local", "conversationId": a.cid}, timeout_ms=12000)
if r.get("resultType") != "success":
    print("no owner:", r.get("error")); sys.exit(1)
owner = r["handledByClientId"]; print("owner", owner, flush=True)
c.send({"type": "broadcast", "method": "thread-stream-following-changed", "sourceClientId": c.client_id,
        "targetClientIds": [owner], "params": {"conversationId": a.cid, "hostId": "local", "following": True},
        "version": version_for("thread-stream-following-changed")})
# wait for the snapshot so we know the thread's current settings
snap = None; t_end = time.monotonic() + 10
while time.monotonic() < t_end and snap is None:
    m = c.recv(0.5)
    if m and m.get("type") == "broadcast" and m.get("method") == "thread-stream-state-changed" \
            and (m["params"].get("change") or {}).get("type") == "snapshot":
        snap = m["params"]["change"]["conversationState"]
if snap is None:
    print("no snapshot received"); sys.exit(1)
perm = snap.get("currentPermissions") or {}
print("thread status before:", snap.get("threadRuntimeStatus"), "permissions:", json.dumps(perm)[:200], flush=True)

client_msg_id = str(uuid.uuid4())
request = {
    "threadId": a.cid,
    "turnTrigger": "composer",
    "responsesapiClientMetadata": {"source": "codex", "client_type": "extension"},
    "clientUserMessageId": client_msg_id,
    "input": [{"type": "text", "text": a.text, "text_elements": []}],
    "cwd": snap.get("cwd"),
    "model": None, "effort": None,
    "multiAgentMode": "explicitRequestOnly",
    "serviceTier": None,
    "collaborationMode": snap.get("latestCollaborationMode"),
    "approvalPolicy": perm.get("approvalPolicy"),
    "approvalsReviewer": perm.get("approvalsReviewer"),
    "sandboxPolicy": perm.get("sandboxPolicy"),
    "permissions": None, "runtimeWorkspaceRoots": None,
    "summary": "none", "personality": None, "outputSchema": None,
    "attachments": [], "commentAttachments": [],
    "useAppServerPermissionDefault": True,
}
params = {"conversationId": a.cid, "turnStart": {"request": request, "context": {"inheritThreadSettings": True}}}
t0 = time.monotonic()
resp = c.request("thread-follower-start-turn", params, target=owner, host_id=None, timeout_ms=30000)
print(f"thread-follower-start-turn -> {resp.get('resultType')} in {time.monotonic()-t0:.2f}s: "
      f"{json.dumps(resp.get('result') or resp.get('error'), ensure_ascii=False)[:600]}", flush=True)

os.makedirs(os.path.dirname(a.out), exist_ok=True)
n = 0; final_text = None; status = None
with open(a.out, "w") as f:
    deadline = time.monotonic() + a.seconds
    while time.monotonic() < deadline:
        m = c.recv(min(1.0, deadline - time.monotonic()))
        if not m: continue
        if m.get("type") == "broadcast" and m.get("method") == "thread-stream-state-changed":
            f.write(json.dumps({"t": time.time(), "msg": m}) + "\n"); n += 1
            ch = m["params"]["change"]
            if ch["type"] == "snapshot":
                status = ch["conversationState"].get("threadRuntimeStatus")
                print(f"{time.strftime('%H:%M:%S')} snapshot rev={ch['revision']} status={status}", flush=True)
                continue
            for p in ch.get("patches") or []:
                path = p["path"]
                if path == ["threadRuntimeStatus"]:
                    status = p["value"]; print(f"{time.strftime('%H:%M:%S')} status -> {status}", flush=True)
                elif path[-1] == "status" and len(path) == 5:
                    print(f"{time.strftime('%H:%M:%S')} turn status -> {p['value']}", flush=True)
                elif "items" in path and p["op"] == "add" and isinstance(p.get("value"), dict):
                    v = p["value"]; print(f"{time.strftime('%H:%M:%S')} item add {v.get('type')} {v.get('id','')[:14]} {json.dumps(v.get('content') or v.get('text') or '', ensure_ascii=False)[:120]}", flush=True)
                elif path[-1] == "text" and "items" in path:
                    final_text = p["value"]
            if status == {"type": "idle"} and n > 3:
                break
        elif m.get("type") == "client-discovery-request":
            c.on_other(m)
print("final agent text:", json.dumps(final_text, ensure_ascii=False)[:400])
c.send({"type": "broadcast", "method": "thread-stream-following-changed", "sourceClientId": c.client_id,
        "targetClientIds": [owner], "params": {"conversationId": a.cid, "hostId": "local", "following": False},
        "version": version_for("thread-stream-following-changed")})
print("recorded", n, "messages to", a.out)
