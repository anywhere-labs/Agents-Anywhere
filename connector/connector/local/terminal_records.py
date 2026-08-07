from __future__ import annotations

import base64
from typing import Any


def terminal_view(record: dict[str, Any], pid: int | None) -> dict[str, Any]:
    return {
        "terminalId": record["id"],
        "sessionId": record["sessionId"],
        "label": record["label"],
        "purpose": "user",
        "pid": pid if not record["closed"] else None,
        "cols": record["cols"],
        "rows": record["rows"],
        "cwd": record["cwd"],
        "shell": record["shell"],
        "closed": record["closed"],
        "status": record["status"],
        "exitCode": record["exitCode"],
        "scrollbackBytes": len(record["scrollback"]),
        "scrollbackSeq": record["seq"],
        "createdAt": record["createdAt"],
    }


def append_scrollback(record: dict[str, Any], data: bytes, max_bytes: int) -> None:
    data_base64 = base64.b64encode(data).decode("ascii")
    record["chunks"].append({"seq": record["seq"], "dataBase64": data_base64, "bytes": len(data)})
    record["chunksBytes"] += len(data)
    while record["chunks"] and record["chunksBytes"] > max_bytes:
        removed = record["chunks"].pop(0)
        record["chunksBytes"] -= removed["bytes"]
    scrollback = record["scrollback"]
    scrollback.extend(data)
    overflow = len(scrollback) - max_bytes
    if overflow <= 0:
        return
    del scrollback[:overflow]
    record["scrollbackBaseSeq"] = (record["chunks"][0]["seq"] - 1) if record["chunks"] else record["seq"]
