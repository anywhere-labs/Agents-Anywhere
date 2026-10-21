"""Follow one owned thread over the IPC router and record every
thread-stream-state-changed message (snapshot + patches) to a JSONL file.
Read-only: never sends thread-follower-* commands.

Usage: python ipc_stream_recorder.py --seconds N --out FILE conversationId
"""
from __future__ import annotations
import argparse, json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ipc_router_probe import IpcConn, ipc_socket_path, version_for  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--seconds", type=float, default=180)
ap.add_argument("--out", default="/tmp/codex-ipc-dumps/stream.jsonl")
ap.add_argument("cid")
a = ap.parse_args()
os.makedirs(os.path.dirname(a.out), exist_ok=True)
c = IpcConn(ipc_socket_path()); r = c.request("initialize", {"clientType": "agents-anywhere"}); c.client_id = r["result"]["clientId"]
r = c.request("thread-owner-discovery", {"hostId": "local", "conversationId": a.cid}, timeout_ms=12000)
if r.get("resultType") != "success":
    print("no owner:", r.get("error")); sys.exit(1)
owner = r["handledByClientId"]; print("owner", owner, flush=True)
def follow(flag):
    c.send({"type": "broadcast", "method": "thread-stream-following-changed", "sourceClientId": c.client_id,
            "targetClientIds": [owner], "params": {"conversationId": a.cid, "hostId": "local", "following": flag},
            "version": version_for("thread-stream-following-changed")})
follow(True)
n = 0
with open(a.out, "w") as f:
    deadline = time.monotonic() + a.seconds
    while time.monotonic() < deadline:
        m = c.recv(min(1.0, deadline - time.monotonic()))
        if not m:
            continue
        if m.get("type") == "broadcast" and m.get("method") == "thread-stream-state-changed":
            f.write(json.dumps({"t": time.time(), "msg": m}) + "\n"); f.flush(); n += 1
            ch = m["params"].get("change") or {}
            paths = sorted({"/".join(str(x) for x in (pp.get("path") or [])[:4]) for pp in (ch.get("patches") or [])})[:6]
            print(f"{time.strftime('%H:%M:%S')} {ch.get('type')} rev={ch.get('revision')} n={len(ch.get('patches') or [])} {paths}", flush=True)
        elif m.get("type") == "client-discovery-request":
            c.on_other(m)
        elif m.get("type") == "broadcast":
            print(f"{time.strftime('%H:%M:%S')} other broadcast {m.get('method')} from={m.get('sourceClientId')}", flush=True)
follow(False)
print("recorded", n, "messages to", a.out)
