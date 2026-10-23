"""MiMo runtime contract tests (AA protocol v2).

Run:
  python connector/connector/runtimes/mimo/tests_contract.py
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

PKG_ROOT = Path(__file__).resolve().parents[3]  # .../connector
if str(PKG_ROOT.parent) not in sys.path:
    sys.path.insert(0, str(PKG_ROOT.parent))

from connector.runtime_protocol import (  # noqa: E402
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeOperationResult,
    RuntimeResourceClaim,
    RuntimeSourceKey,
)
from connector.runtimes.mimo import MimoRuntimeProvider  # noqa: E402
from connector.runtimes.mimo.db import default_mimocode_db  # noqa: E402
from connector.runtimes.mimo.runtime import MimoAgentRuntime  # noqa: E402


class FakeHost:
    def __init__(self):
        self.states = []

    async def notify_session_state(self, st):
        self.states.append(st)


def assert_identity(identity: RuntimeIdentity):
    assert identity.runtime == "mimo"
    assert identity.runtime_version, "runtime_version required"
    assert identity.display_name
    assert identity.protocol_version


async def main() -> int:
    provider = MimoRuntimeProvider()
    desc = await provider.discover()
    assert desc.runtime_type == "mimo"
    assert desc.available is True, "mimo should be available when mimocode.db exists"

    cfg = await provider.validate_config({})
    assert isinstance(cfg, RuntimeConfig)
    claims = provider.resource_claims(cfg)
    assert len(claims) >= 1
    assert all(isinstance(c, RuntimeResourceClaim) for c in claims)
    key = provider.session_source_key(cfg)
    assert isinstance(key, RuntimeSourceKey)

    host = FakeHost()
    rt = await provider.create_runtime(cfg, host=host)
    assert isinstance(rt, MimoAgentRuntime)
    assert_identity(rt.identity)
    await rt.start()

    sessions = await rt.list_sessions(limit=10)
    assert sessions, "expected local MiMo sessions"
    meta = sessions[0]
    assert meta.external_session_id and meta.external_session_id.startswith("ses_")
    snap = await rt.get_session_snapshot(meta.session_id, meta.external_session_id, limit=50)
    assert snap.items, "timeline items"
    assert snap.complete is True
    st = await rt.get_session_state(meta.session_id, meta.external_session_id)
    assert st.status in ("idle", "running", "stopped", "error")

    # interrupt contract: must not leave a live process
    sid = meta.session_id
    ext = meta.external_session_id
    # simulate running process
    import subprocess

    fake = subprocess.Popen(["cmd", "/c", "ping", "-n", "30", "127.0.0.1"])
    rt._procs[ext] = fake
    rt._status[ext] = "running"
    res = await rt.interrupt_session(sid, reason="test")
    assert isinstance(res, RuntimeOperationResult)
    assert res.ok
    assert res.result.get("interrupted") is True
    assert res.result.get("process_alive") is False
    assert fake.poll() is not None, "process must be terminated"

    # create_and_start_session returns native id in result
    if rt._mimo_bin:
        cres = await rt.create_and_start_session(
            session_id="sess_mimo_test",
            content="say hi in one short sentence",
            cwd=str(Path.cwd()),
        )
        assert isinstance(cres, RuntimeOperationResult)
        assert cres.ok, cres.message
        assert cres.result.get("external_session_id", "").startswith("ses_") or cres.result.get(
            "external_session_id"
        )
    else:
        print("SKIP start_turn: mimo CLI not on PATH")

    await provider.stop_runtime(rt)
    print("CONTRACT OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
