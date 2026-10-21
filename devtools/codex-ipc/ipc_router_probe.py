"""Passive probe for the Codex IDE/desktop IPC router (``$CODEX_HOME/ipc/ipc.sock``).

Frame format: 4-byte little-endian length prefix + UTF-8 JSON. Message types:
``request`` / ``response`` / ``broadcast`` / ``client-discovery-request`` /
``client-discovery-response``. This probe registers as a client, listens to
broadcasts for a while and, if conversation ids are given, asks the router who
owns each thread via ``thread-owner-discovery`` (a read-only query). It never
answers discovery requests with canHandle=true and never sends follower commands.

Usage: python ipc_router_probe.py [--client-type TYPE] [--listen SECONDS] [conversationId ...]
"""
from __future__ import annotations

import argparse
import json
import os
import socket
import struct
import sys
import time
import uuid

INITIALIZING = "initializing-client"
METHOD_VERSIONS = {
    "thread-stream-state-changed": 11,
    "thread-stream-following-changed": 1,
    "thread-stream-following-status-requested": 1,
    "ipc-connection-reset": 1,
    "thread-read-state-changed": 3,
    "thread-archived": 2,
    "thread-unarchived": 1,
    "thread-owner-discovery": 1,
    "thread-follower-start-turn": 2,
    "thread-follower-load-complete-history": 1,
    "thread-follower-compact-thread": 1,
    "thread-follower-steer-turn": 1,
    "thread-follower-interrupt-turn": 4,
    "thread-follower-update-thread-settings": 2,
    "thread-follower-update-daybreak": 1,
    "thread-follower-read-model-settings": 1,
    "thread-follower-edit-last-user-turn": 2,
    "thread-follower-command-approval-decision": 1,
    "thread-follower-file-approval-decision": 1,
    "thread-follower-permissions-request-approval-response": 1,
    "thread-follower-submit-user-input": 1,
    "thread-follower-submit-mcp-server-elicitation-response": 1,
    "thread-follower-set-queued-follow-ups-state": 1,
    "thread-follower-remove-queued-message": 1,
    "thread-follower-clear-queued-messages": 1,
    "thread-queued-followups-changed": 2,
}


def version_for(method: str, host_id: str | None = None) -> int:
    base = METHOD_VERSIONS.get(method, 0)
    if host_id is not None and method.startswith("thread-follower-"):
        return base + 1
    return base


def ipc_socket_path() -> str:
    home = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
    return os.path.join(home, "ipc", "ipc.sock")


class IpcConn:
    def __init__(self, path: str) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        self.buf = b""
        self.client_id = INITIALIZING

    def send(self, obj: dict) -> None:
        payload = json.dumps(obj).encode()
        self.sock.sendall(struct.pack("<I", len(payload)) + payload)

    def recv(self, timeout: float | None) -> dict | None:
        self.sock.settimeout(timeout)
        try:
            while len(self.buf) < 4:
                chunk = self.sock.recv(65536)
                if not chunk:
                    raise RuntimeError("router closed the socket")
                self.buf += chunk
            (n,) = struct.unpack("<I", self.buf[:4])
            while len(self.buf) < 4 + n:
                chunk = self.sock.recv(65536)
                if not chunk:
                    raise RuntimeError("router closed the socket")
                self.buf += chunk
            payload, self.buf = self.buf[4 : 4 + n], self.buf[4 + n :]
            return json.loads(payload.decode("utf-8"))
        except socket.timeout:
            return None

    def request(self, method: str, params: dict, *, target: str | None = None, host_id: str | None = None,
                timeout_ms: int = 5000) -> dict:
        rid = str(uuid.uuid4())
        msg = {
            "type": "request",
            "requestId": rid,
            "sourceClientId": self.client_id,
            "version": version_for(method, host_id),
            "method": method,
            "params": params,
            "targetClientId": target,
            "hostId": host_id,
            "timeoutMs": timeout_ms,
        }
        self.send(msg)
        deadline = time.monotonic() + timeout_ms / 1000 + 1
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(method)
            m = self.recv(remaining)
            if m is None:
                continue
            if m.get("type") == "response" and m.get("requestId") == rid:
                return m
            self.on_other(m)

    def on_other(self, m: dict) -> None:
        t = m.get("type")
        if t == "broadcast":
            params = m.get("params") or {}
            summary = {k: (v if isinstance(v, (str, int, bool)) or v is None else type(v).__name__)
                       for k, v in params.items()} if isinstance(params, dict) else params
            change = params.get("change") if isinstance(params, dict) else None
            if isinstance(change, dict):
                summary["change"] = {k: (v if k in ("type", "revision", "baseRevision") else type(v).__name__)
                                     for k, v in change.items()}
            print(f"  <- broadcast {m.get('method')} v{m.get('version')} from={m.get('sourceClientId')} "
                  f"targets={m.get('targetClientIds')} params={json.dumps(summary)[:400]}")
        elif t == "client-discovery-request":
            req = m.get("request") or {}
            print(f"  <- discovery asked: can we handle {req.get('method')}? answering no")
            self.send({"type": "client-discovery-response", "requestId": m["requestId"],
                       "response": {"canHandle": False}})
        elif t == "request":
            print(f"  <- request {m.get('method')} -> replying no-handler-for-request")
            self.send({"type": "response", "requestId": m["requestId"], "resultType": "error",
                       "error": "no-handler-for-request"})
        else:
            print(f"  <- {t}: {json.dumps(m)[:300]}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--client-type", default="agents-anywhere")
    ap.add_argument("--listen", type=float, default=5.0)
    ap.add_argument("conversation_ids", nargs="*")
    args = ap.parse_args()

    path = ipc_socket_path()
    print(f"ipc router socket: {path}")
    conn = IpcConn(path)
    resp = conn.request("initialize", {"clientType": args.client_type})
    print("initialize ->", json.dumps(resp))
    if resp.get("resultType") != "success":
        return 1
    conn.client_id = resp["result"]["clientId"]

    for cid in args.conversation_ids:
        try:
            r = conn.request("thread-owner-discovery", {"hostId": "local", "conversationId": cid}, timeout_ms=12000)
        except TimeoutError:
            print(f"  owner of {cid}: timeout")
            continue
        if r.get("resultType") == "success":
            print(f"  owner of {cid}: client {r.get('handledByClientId')} result={json.dumps(r.get('result'))}")
        else:
            print(f"  owner of {cid}: {r.get('error')}")

    print(f"listening to broadcasts for {args.listen:.0f}s ...")
    deadline = time.monotonic() + args.listen
    while time.monotonic() < deadline:
        m = conn.recv(min(1.0, deadline - time.monotonic()))
        if m:
            conn.on_other(m)
    conn.sock.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
