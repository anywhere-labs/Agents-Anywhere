from __future__ import annotations

import hashlib
import json
import tempfile
from collections.abc import Iterable
from typing import Any, BinaryIO

from connector.server.runtime_rpc_payloads import server_payload_without_turn_data


def snapshot_body(
    runtime: str, runtime_id: str, session_id: str,
    meta: dict[str, Any], items: Iterable[dict[str, Any]], through_seq: int,
) -> BinaryIO:
    body = tempfile.TemporaryFile(mode="w+b")  # noqa: SIM115 - ownership transfers to the async uploader
    encoder = json.JSONEncoder(ensure_ascii=False, separators=(",", ":"), allow_nan=False, sort_keys=True)

    def encode(value):
        for part in encoder.iterencode(server_payload_without_turn_data(value)):
            body.write(part.encode("utf-8"))

    try:
        meta = dict(meta)
        if isinstance(meta.get("sourceState"), dict):
            meta["sourceState"] = {k: v for k, v in meta["sourceState"].items() if k != "observedAt"}
        binding = {"runtime": runtime, "runtimeId": runtime_id, "sessionId": session_id}
        body.write(b'{"notifications":[')
        encode({"method": "session.meta.upsert", "params": {**meta, **binding}})
        body.write(b',{"method":"timeline.sync","params":')
        params = {**binding, "externalSessionId": meta["externalSessionId"], "complete": True, "snapshotSeq": through_seq}
        # Leave the final object open to encode items one at a time.
        encode(params)
        body.seek(-1, 1)
        body.write(b',"items":[')
        first = True
        for item in items:
            if not first:
                body.write(b',')
            encode(item)
            first = False
        body.write(b']}}]}')
        body.seek(0)
        return body
    except BaseException:
        body.close()
        raise


def body_digest(body: BinaryIO) -> tuple[str, int]:
    body.seek(0)
    digest = hashlib.sha256()
    size = 0
    while chunk := body.read(64 * 1024):
        digest.update(chunk)
        size += len(chunk)
    body.seek(0)
    return digest.hexdigest(), size
