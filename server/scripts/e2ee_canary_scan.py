"""E-1 canary scan: look for planted strings everywhere the Server side keeps or sends bytes.

``docs/v3/11-e2ee-noise.md`` §13 E-1: in encrypted mode, random unique strings placed in messages, files,
terminals, titles, attachments and shares must never show up in PostgreSQL, Redis, object storage, Server and
Router logs, or Server-side traffic (Server <-> Router, Router <-> device).

The scan is plain substring search over every encoding a careless implementation could produce: the raw UTF-8
bytes, UTF-16LE, hex, and standard / URL-safe base64 at all three alignments. WebSocket captures are decoded
first (client frames are masked, ``permessage-deflate`` payloads are inflated), so a plaintext string inside a
frame is found even though it never appears as-is on the wire.

Used by ``tests/test_e2ee_canary.py`` and from the command line against a running deployment::

    uv run python -m scripts.e2ee_canary_scan --canary-file canaries.txt \\
        --db-url postgresql+asyncpg://... --redis-url redis://... \\
        --files-root /var/lib/agents-anywhere/files --logs server.log router.log \\
        --capture server-router.bin --ws-capture device-router.bin

Object storage on S3: mirror the bucket first (``aws s3 sync`` / ``mc mirror``) and pass the directory as
``--files-root``. Exit status 1 when anything is found.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import os
import secrets
import sys
import zlib
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path

CANARY_PREFIX = "AACANARY"


def new_canary(label: str) -> str:
    """A random string that cannot occur by chance; ``label`` only helps reading the report."""

    return f"{CANARY_PREFIX}{label.upper()}{secrets.token_hex(12)}"


@dataclass(frozen=True)
class Hit:
    source: str
    canary: str
    encoding: str
    context: str

    def __str__(self) -> str:
        return f"{self.source}: {self.canary} ({self.encoding}) …{self.context}…"


def _base64_needles(data: bytes, alphabet: str) -> Iterator[bytes]:
    encode = base64.b64encode if alphabet == "base64" else base64.urlsafe_b64encode
    for shift in range(3):
        # Encode with 0-2 bytes of unknown prefix; keep only the characters fully determined by ``data``.
        encoded = encode(b"\0" * shift + data).rstrip(b"=")
        lead = (shift * 8 + 5) // 6 if shift else 0
        tail_bits = ((shift + len(data)) * 8) % 6
        body = encoded[lead : len(encoded) - (1 if tail_bits else 0)]
        if len(body) >= 8:
            yield body


def needles(canary: str) -> list[tuple[str, bytes]]:
    raw = canary.encode()
    out = [("utf-8", raw), ("utf-16le", canary.encode("utf-16le")), ("hex", binascii.hexlify(raw))]
    out.append(("hex-upper", binascii.hexlify(raw).upper()))
    for alphabet in ("base64", "base64url"):
        out.extend((alphabet, needle) for needle in _base64_needles(raw, alphabet))
    return out


def scan_bytes(source: str, data: bytes, canaries: Iterable[str]) -> list[Hit]:
    hits: list[Hit] = []
    if not data:
        return hits
    for canary in canaries:
        for encoding, needle in needles(canary):
            at = data.find(needle)
            if at >= 0:
                context = data[max(0, at - 40) : at + len(needle) + 40].decode("utf-8", "replace")
                hits.append(Hit(source, canary, encoding, context.replace("\n", " ")))
                break
    return hits


# ---------------------------------------------------------------------------
# WebSocket captures
# ---------------------------------------------------------------------------


def websocket_payloads(stream: bytes) -> list[bytes]:
    """Decoded message payloads of one direction of a WebSocket connection, HTTP upgrade included.

    Unmasks client frames, joins fragments and inflates ``permessage-deflate`` messages (RSV1). A truncated
    tail is ignored; whatever cannot be parsed is returned as-is so the raw bytes are still scanned.
    """

    head_end = stream.find(b"\r\n\r\n")
    if not stream.startswith((b"GET ", b"HTTP/")) or head_end < 0:
        return [stream]
    out = [stream[: head_end + 4]]
    pos = head_end + 4
    inflater = zlib.decompressobj(-15)
    message = bytearray()
    compressed = False
    while pos + 2 <= len(stream):
        b0, b1 = stream[pos], stream[pos + 1]
        fin, rsv1, opcode = b0 & 0x80, b0 & 0x40, b0 & 0x0F
        masked, length = b1 & 0x80, b1 & 0x7F
        pos += 2
        if length == 126:
            if pos + 2 > len(stream):
                break
            length = int.from_bytes(stream[pos : pos + 2], "big")
            pos += 2
        elif length == 127:
            if pos + 8 > len(stream):
                break
            length = int.from_bytes(stream[pos : pos + 8], "big")
            pos += 8
        mask = b""
        if masked:
            mask = stream[pos : pos + 4]
            pos += 4
        payload = stream[pos : pos + length]
        pos += length
        if len(payload) < length:
            break
        if masked:
            payload = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        if opcode >= 0x8:  # control frames are never fragmented or compressed
            out.append(payload)
            continue
        if opcode != 0x0:
            message.clear()
            compressed = bool(rsv1)
        message += payload
        if not fin:
            continue
        data = bytes(message)
        message.clear()
        if compressed:
            try:
                data = inflater.decompress(data + b"\x00\x00\xff\xff")
            except zlib.error:
                inflater = zlib.decompressobj(-15)
        out.append(data)
    if pos < len(stream):
        out.append(stream[pos:])
    return out


def scan_websocket(source: str, stream: bytes, canaries: Iterable[str]) -> list[Hit]:
    canaries = list(canaries)
    hits = scan_bytes(f"{source} (raw)", stream, canaries)
    for payload in websocket_payloads(stream):
        hits.extend(scan_bytes(source, payload, canaries))
    return hits


# ---------------------------------------------------------------------------
# Stores
# ---------------------------------------------------------------------------


async def postgres_dump(db_url: str) -> dict[str, bytes]:
    """``{table: every row as text}`` for every table in the ``public`` schema."""

    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine

    engine = create_async_engine(db_url)
    try:
        async with engine.connect() as conn:
            tables = (
                await conn.execute(text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"))
            ).scalars().all()
            dump: dict[str, bytes] = {}
            for table in tables:
                rows = (await conn.execute(text(f'SELECT t::text FROM public."{table}" AS t'))).scalars().all()
                dump[table] = "\n".join(rows).encode()
            return dump
    finally:
        await engine.dispose()


async def scan_postgres(db_url: str, canaries: Iterable[str]) -> list[Hit]:
    canaries = list(canaries)
    hits: list[Hit] = []
    for table, data in (await postgres_dump(db_url)).items():
        hits.extend(scan_bytes(f"postgres:{table}", data, canaries))
    return hits


async def redis_dump(redis_url: str) -> dict[str, bytes]:
    """``{key: name + value}`` for every key of the database in ``redis_url`` (all value types)."""

    from redis.asyncio import Redis

    client = Redis.from_url(redis_url)
    dump: dict[str, bytes] = {}
    try:
        async for key in client.scan_iter(count=500):
            kind = (await client.type(key)).decode()
            if kind == "string":
                parts = [await client.get(key) or b""]
            elif kind == "hash":
                parts = [b for pair in (await client.hgetall(key)).items() for b in pair]
            elif kind == "list":
                parts = await client.lrange(key, 0, -1)
            elif kind == "set":
                parts = list(await client.smembers(key))
            elif kind == "zset":
                parts = await client.zrange(key, 0, -1)
            elif kind == "stream":
                parts = [
                    b
                    for _id, fields in await client.xrange(key)
                    for pair in fields.items()
                    for b in pair
                ]
            else:
                parts = []
            dump[key.decode("utf-8", "replace")] = b"\n".join([key, *parts])
        return dump
    finally:
        await client.aclose()


async def scan_redis(redis_url: str, canaries: Iterable[str]) -> list[Hit]:
    canaries = list(canaries)
    hits: list[Hit] = []
    for key, data in (await redis_dump(redis_url)).items():
        hits.extend(scan_bytes(f"redis:{key}", data, canaries))
    return hits


def scan_tree(source: str, root: Path, canaries: Iterable[str]) -> tuple[list[Hit], int]:
    """Every file under ``root`` (object storage on disk, a mirrored bucket, a log directory)."""

    canaries = list(canaries)
    hits: list[Hit] = []
    count = 0
    for path in sorted(p for p in root.rglob("*") if p.is_file()):
        count += 1
        hits.extend(scan_bytes(f"{source}:{path.relative_to(root)}", path.name.encode(), canaries))
        hits.extend(scan_bytes(f"{source}:{path.relative_to(root)}", path.read_bytes(), canaries))
    return hits, count


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


async def _main(args: argparse.Namespace) -> int:
    canaries = [line.strip() for line in Path(args.canary_file).read_text().splitlines() if line.strip()]
    canaries += args.canary or []
    if not canaries:
        print("no canaries given", file=sys.stderr)
        return 2
    hits: list[Hit] = []
    if args.db_url:
        hits += await scan_postgres(args.db_url, canaries)
    if args.redis_url:
        hits += await scan_redis(args.redis_url, canaries)
    for root in args.files_root or []:
        found, count = scan_tree("files", Path(root), canaries)
        print(f"scanned {count} files under {root}")
        hits += found
    for path in args.logs or []:
        p = Path(path)
        hits += scan_tree("logs", p, canaries)[0] if p.is_dir() else scan_bytes(f"log:{path}", p.read_bytes(), canaries)
    for path in args.capture or []:
        hits += scan_bytes(f"capture:{path}", Path(path).read_bytes(), canaries)
    for path in args.ws_capture or []:
        hits += scan_websocket(f"ws:{path}", Path(path).read_bytes(), canaries)
    for hit in hits:
        print(hit)
    print(f"{len(hits)} hit(s) for {len(canaries)} canaries")
    return 1 if hits else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--canary-file", default=os.devnull, help="one canary per line")
    parser.add_argument("--canary", action="append", help="a canary (repeatable)")
    parser.add_argument("--db-url", help="SQLAlchemy async URL of the Server database")
    parser.add_argument("--redis-url", help="Redis URL of the Server (one logical database)")
    parser.add_argument("--files-root", action="append", help="object storage on disk or a mirrored bucket")
    parser.add_argument("--logs", action="append", help="a log file or directory (Server, Router, proxy)")
    parser.add_argument("--capture", action="append", help="raw captured bytes (TCP payload, decrypted TLS)")
    parser.add_argument("--ws-capture", action="append", help="one direction of a WebSocket connection")
    return asyncio.run(_main(parser.parse_args(argv)))


if __name__ == "__main__":
    raise SystemExit(main())
