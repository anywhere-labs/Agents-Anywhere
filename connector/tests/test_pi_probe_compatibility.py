"""The no-model smoke probe must not send a flag absent from installed Pi help."""
from __future__ import annotations

import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.mark.parametrize("has_no_mcp", [False, True])
def test_probe_uses_optional_no_mcp_only_when_supported(monkeypatch, has_no_mcp):
    path = Path(__file__).resolve().parents[1] / "scripts/probe_pi.py"
    spec = importlib.util.spec_from_file_location("pi_probe_under_test", path)
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    help_text = "--mode --no-session --session-dir --extension --no-extensions --no-skills "
    help_text += "--no-prompt-templates --no-tools --no-context-files --offline"
    if has_no_mcp:
        help_text += " --no-mcp"
    sent = []
    monkeypatch.setattr(probe, "resolve_pi_command", lambda _: ["test-pi"])

    def subprocess_run(args, **kwargs):
        return SimpleNamespace(stdout=b"0.87.1" if "--version" in args else help_text.encode(), returncode=0)

    class FakeRpc:
        returncode = None

        def __init__(self, args, **kwargs):
            sent.extend(args)
            assert kwargs["env"]["PI_OFFLINE"] == "1"
            assert Path(kwargs["cwd"]).is_dir()

        async def start(self):
            if not has_no_mcp and "--no-mcp" in sent:
                raise RuntimeError("synthetic_unknown_option")

        async def request(self, command):
            assert command == {"type": "get_state"}
            return {"success": True}

        async def close(self, **kwargs):
            self.returncode = 0

    monkeypatch.setattr(probe.subprocess, "run", subprocess_run)
    monkeypatch.setattr(probe, "PiRpcProcess", FakeRpc)
    result = asyncio.run(probe.probe())
    assert result["rpc_ok"] is True
    assert result["child_stopped"] is True
    assert ("--no-mcp" in sent) is has_no_mcp
    assert {"--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates",
            "--no-tools", "--no-context-files", "--offline"} <= set(sent)
