"""Local smoke test for MiMo runtime (no AA server required).

Run from Agents-Anywhere root or connector/:
  python connector/connector/runtimes/mimo/tests_smoke.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

# allow `python path/to/tests_smoke.py` without package install
ROOT = Path(__file__).resolve().parents[4]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
# package path: connector/connector/runtimes/mimo -> parents[2]=connector package root
PKG = Path(__file__).resolve().parents[2]
if str(PKG.parent) not in sys.path:
    sys.path.insert(0, str(PKG.parent))

try:
    from connector.runtimes.mimo.db import MimoDb, default_mimocode_db
    from connector.runtimes.mimo.provider import MimoRuntimeProvider
    from connector.runtimes.mimo.runtime import MimoAgentRuntime
except ImportError:
    sys.path.insert(0, str(PKG.parent.parent))
    from connector.runtimes.mimo.db import MimoDb, default_mimocode_db  # type: ignore
    from connector.runtimes.mimo.provider import MimoRuntimeProvider  # type: ignore
    from connector.runtimes.mimo.runtime import MimoAgentRuntime  # type: ignore


async def main() -> int:
    provider = MimoRuntimeProvider()
    inv = await provider.discover()
    print("discover:", inv if isinstance(inv, dict) else getattr(inv, "__dict__", inv))

    db_path = default_mimocode_db()
    print("mimocode.db:", db_path)
    if not db_path:
        print("SKIP: no mimocode.db on this machine")
        return 0

    db = MimoDb(db_path)
    sessions = db.list_sessions()
    print("sessions:", len(sessions))
    for s in sessions[:5]:
        print(" -", s.id, s.title[:40], s.cwd)

    if not sessions:
        print("SKIP: empty session table")
        return 0

    rt = MimoAgentRuntime(db_path=db_path, mimo_bin=None, default_cwd=str(Path.cwd()))
    await rt.start()
    print("identity:", rt.identity())
    listed = await rt.list_sessions()
    print("list_sessions:", len(listed))
    sid = listed[0]["session_id"]
    ext = listed[0]["external_session_id"]
    snap = await rt.read_timeline(sid, ext)
    print("timeline items:", len(snap["items"]))
    if snap["items"]:
        first = snap["items"][0]
        print(" first role=", first.get("role"), "text=", str(first.get("content", {}).get("text", ""))[:80])
    state = await rt.get_state(sid, ext)
    print("state:", state)
    await rt.stop()

    if len(snap["items"]) < 1:
        print("FAIL: expected at least one timeline item")
        return 1
    print("SMOKE OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
