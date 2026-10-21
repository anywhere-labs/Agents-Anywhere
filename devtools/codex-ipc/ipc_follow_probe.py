"""Positive-path probe for the IPC owner/follower protocol (read-only).

For each conversation id: ``thread-owner-discovery``; when an owner answers,
broadcast ``thread-stream-following-changed {following:true}`` to it, dump the
structure of the snapshot / patches we receive for a while, then send
``following:false``. We never send ``thread-follower-*`` commands and never
answer discovery with canHandle=true.

Usage: python ipc_follow_probe.py [--listen SECONDS] conversationId ...
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from ipc_router_probe import IpcConn, ipc_socket_path, version_for  # noqa: E402


def shape(v, depth=0):
    if isinstance(v, dict):
        if depth >= 2:
            return f"dict[{len(v)} keys]"
        return {k: shape(x, depth + 1) for k, x in list(v.items())[:40]}
    if isinstance(v, list):
        return f"list[{len(v)}]" + (f" of {shape(v[0], depth + 1)}" if v and depth < 2 else "")
    if isinstance(v, str):
        return f"str({len(v)})" if len(v) > 40 else v
    return v


def broadcast(conn: IpcConn, method: str, params: dict, targets: list[str] | None = None) -> None:
    conn.send({"type": "broadcast", "method": method, "sourceClientId": conn.client_id,
               "targetClientIds": targets, "params": params, "version": version_for(method)})


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", type=float, default=20.0)
    ap.add_argument("conversation_ids", nargs="+")
    args = ap.parse_args()

    conn = IpcConn(ipc_socket_path())
    resp = conn.request("initialize", {"clientType": "agents-anywhere"})
    conn.client_id = resp["result"]["clientId"]
    print("our clientId:", conn.client_id)

    owners: dict[str, str] = {}
    for cid in args.conversation_ids:
        r = conn.request("thread-owner-discovery", {"hostId": "local", "conversationId": cid}, timeout_ms=12000)
        if r.get("resultType") == "success":
            owners[cid] = r["handledByClientId"]
            print(f"OWNER FOUND {cid}: client={r['handledByClientId']} result={json.dumps(r.get('result'))}")
        else:
            print(f"  {cid}: {r.get('error')}")
    if not owners:
        print("no owned thread found; open/run one in the Codex app and retry")
        return 1

    for cid, owner in owners.items():
        broadcast(conn, "thread-stream-following-changed",
                  {"conversationId": cid, "hostId": "local", "following": True}, [owner])
        print(f"-> following {cid} (owner {owner})")

    deadline = time.monotonic() + args.listen
    snapshots = 0
    patches = 0
    while time.monotonic() < deadline:
        m = conn.recv(min(1.0, deadline - time.monotonic()))
        if not m:
            continue
        if m.get("type") == "broadcast" and m.get("method") == "thread-stream-state-changed":
            p = m["params"]
            ch = p.get("change") or {}
            if ch.get("type") == "snapshot":
                snapshots += 1
                st = ch.get("conversationState") or {}
                print(f"\n=== SNAPSHOT conv={p.get('conversationId')} host={p.get('hostId')} rev={ch.get('revision')} "
                      f"from={m.get('sourceClientId')} v{m.get('version')} bytes={len(json.dumps(st))}")
                print("top-level keys:", sorted(st.keys()))
                for k in ("id", "status", "threadRuntimeStatus", "resumeState", "cwd", "latestModel",
                          "latestReasoningEffort", "mode", "source", "originator", "ephemeral", "sessionId",
                          "rolloutPath", "name", "title", "hasUnreadTurn", "activeTurnId", "isStreaming"):
                    if k in st:
                        print(f"  {k}: {json.dumps(st[k])[:200]}")
                print("  requests:", json.dumps(shape(st.get("requests")))[:800])
                turns = st.get("turns")
                print("  turns:", shape(turns))
                if isinstance(turns, list) and turns:
                    print("  last turn shape:", json.dumps(shape(turns[-1]))[:1200])
                th = st.get("turnHistory")
                if th is not None:
                    print("  turnHistory shape:", json.dumps(shape(th))[:600])
                os.makedirs("/tmp/codex-ipc-dumps", exist_ok=True)
                with open(f"/tmp/codex-ipc-dumps/snapshot-{p.get('conversationId')}.json", "w") as f:
                    json.dump(p, f, indent=1)
            else:
                patches += 1
                pl = ch.get("patches") or []
                paths = sorted({"/".join(str(x) for x in (pp.get("path") or [])[:3]) for pp in pl})[:8]
                print(f"  PATCH conv={p.get('conversationId')[:8]} base={ch.get('baseRevision')} -> {ch.get('revision')} "
                      f"n={len(pl)} paths={paths} acceptedTextChanges={shape(ch.get('acceptedTextChanges'))}")
        else:
            conn.on_other(m)

    for cid, owner in owners.items():
        broadcast(conn, "thread-stream-following-changed",
                  {"conversationId": cid, "hostId": "local", "following": False}, [owner])
    print(f"\ndone: snapshots={snapshots} patches={patches}; raw snapshots in /tmp/codex-ipc-dumps/")
    conn.sock.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
