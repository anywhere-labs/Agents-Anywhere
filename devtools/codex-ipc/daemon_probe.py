"""Read-only probe for the shared Codex app-server daemon.

Connects to ``$CODEX_HOME/app-server-control/app-server-control.sock`` with a
hand-rolled WebSocket client (stdlib only), runs the JSON-RPC ``initialize``
handshake, lists the threads currently loaded in the daemon and reads their
metadata. Nothing is mutated: no turns, no approvals, no thread/resume.

Usage: python daemon_probe.py [--client-name NAME] [--listen SECONDS]
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import socket
import struct
import sys
import time


def control_socket_path() -> str:
    home = os.environ.get("CODEX_HOME") or os.path.expanduser("~/.codex")
    return os.path.join(home, "app-server-control", "app-server-control.sock")


class WsOverUnix:
    def __init__(self, path: str, ws_path: str = "/rpc") -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(path)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {ws_path} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("socket closed during websocket handshake")
            head += chunk
        status, _, rest = head.partition(b"\r\n\r\n")
        if b" 101 " not in status.split(b"\r\n")[0]:
            raise RuntimeError(f"websocket upgrade failed: {status[:200]!r}")
        self.headers = status.decode(errors="replace")
        self.buf = rest
        self.next_id = 1

    def _read_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise RuntimeError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send_frame(self, opcode: int, payload: bytes) -> None:
        mask = os.urandom(4)
        header = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            header += bytes([0x80 | n])
        elif n < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", n)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def recv_text(self, timeout: float | None) -> str | None:
        self.sock.settimeout(timeout)
        fragments = b""
        try:
            while True:
                b0, b1 = self._read_exact(2)
                fin, opcode = b0 & 0x80, b0 & 0x0F
                n = b1 & 0x7F
                if n == 126:
                    n = struct.unpack(">H", self._read_exact(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", self._read_exact(8))[0]
                mask = self._read_exact(4) if b1 & 0x80 else None
                payload = self._read_exact(n)
                if mask:
                    payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
                if opcode == 0x9:
                    self.send_frame(0xA, payload)
                    continue
                if opcode == 0xA:
                    continue
                if opcode == 0x8:
                    raise RuntimeError("server closed websocket")
                fragments += payload
                if fin:
                    return fragments.decode("utf-8", errors="replace")
        except socket.timeout:
            return None

    def send_json(self, obj: dict) -> None:
        self.send_frame(0x1, json.dumps(obj).encode())

    def request(self, method: str, params: dict | None, timeout: float = 10.0) -> dict:
        rid = self.next_id
        self.next_id += 1
        self.send_json({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError(f"{method} timed out")
            raw = self.recv_text(remaining)
            if raw is None:
                continue
            msg = json.loads(raw)
            if msg.get("id") == rid and ("result" in msg or "error" in msg):
                if "error" in msg:
                    raise RuntimeError(f"{method} -> {msg['error']}")
                return msg["result"]
            self.on_other(msg)

    def on_other(self, msg: dict) -> None:
        method = msg.get("method")
        if "id" in msg and method:
            print(f"  <- SERVER REQUEST {method} id={msg['id']} params={json.dumps(msg.get('params'))[:300]}")
        elif method:
            params = msg.get("params") or {}
            tid = params.get("threadId") or (params.get("thread") or {}).get("id")
            print(f"  <- notify {method} thread={tid}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--client-name", default="agents-anywhere-probe")
    ap.add_argument("--listen", type=float, default=0.0, help="seconds to keep listening for notifications")
    args = ap.parse_args()

    path = control_socket_path()
    print(f"control socket: {path} -> {os.path.realpath(path)}")
    ws = WsOverUnix(path)
    print("websocket upgraded; server headers:")
    for line in ws.headers.split("\r\n")[1:]:
        if line:
            print("   ", line)

    init = ws.request(
        "initialize",
        {
            "clientInfo": {"name": args.client_name, "title": "Agents Anywhere probe", "version": "0.0.1"},
            "capabilities": {"experimentalApi": True},
        },
    )
    ws.send_json({"jsonrpc": "2.0", "method": "initialized"})
    print("initialize ->", json.dumps(init)[:400])

    loaded = ws.request("thread/loaded/list", {})
    ids = loaded.get("data", [])
    print(f"thread/loaded/list -> {len(ids)} loaded thread(s)")
    for tid in ids:
        try:
            read = ws.request("thread/read", {"threadId": tid, "includeTurns": False})
        except RuntimeError as exc:
            print(f"  {tid}: thread/read failed: {exc}")
            continue
        th = read.get("thread", read)
        print(
            f"  {tid}: status={json.dumps(th.get('status'))} source={json.dumps(th.get('source'))} "
            f"originator={th.get('originator')} cwd={th.get('cwd')} name={th.get('name')!r} "
            f"ephemeral={th.get('ephemeral')} model={th.get('model')}"
        )

    if args.listen > 0:
        print(f"listening for broadcast notifications for {args.listen:.0f}s ...")
        deadline = time.monotonic() + args.listen
        while time.monotonic() < deadline:
            raw = ws.recv_text(min(1.0, deadline - time.monotonic()))
            if raw:
                ws.on_other(json.loads(raw))
    ws.send_frame(0x8, b"")
    return 0


if __name__ == "__main__":
    sys.exit(main())
