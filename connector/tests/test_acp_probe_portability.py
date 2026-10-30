import asyncio
import os
import runpy
import sys
from pathlib import Path

import psutil
import pytest

from connector.runtimes.acp.domain.definitions import LaunchDefinition
from connector.runtimes.acp.infrastructure.acp.client import AgentClient

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


def test_controlled_acp_peer_uses_utf8_with_windows_pipe_encoding(tmp_path):
    async def verify():
        interactions, updates = [], []

        async def on_interaction(session_id, kind, request):
            interactions.append(request)
            return {"action": "accept", "optionId": "allow"}

        async def on_update(session_id, update):
            updates.append(update)

        client = AgentClient(on_update, on_interaction)
        marker = tmp_path / "writes.txt"
        launch = LaunchDefinition(
            sys.executable,
            (str(SCRIPTS / "acp-controlled-agent.py"), str(marker)),
            "controlled-fixture",
            environment=(("PYTHONIOENCODING", "cp1252"),),
        )
        try:
            async with asyncio.timeout(10):
                await client.start(launch, str(tmp_path))
                session = await client.open_session(str(tmp_path))
                await client.prompt(session["sessionId"], "中文输入", "utf8-probe")
                assert [row["toolCall"]["title"] for row in interactions] == [
                    "创建中的扩展确认",
                    "允许受控文件写入？",
                ]
                assert "".join(row["content"]["text"] for row in updates) == (
                    "受控 输出\u2028完成"
                )
                assert marker.read_text(encoding="utf-8") == "中文输入\n"
        finally:
            await client.close()

    asyncio.run(verify())


@pytest.mark.parametrize("disappears_during", ["lookup", "status"])
def test_process_cleanup_accepts_child_exit_during_poll(monkeypatch, disappears_during):
    probe = runpy.run_path(str(SCRIPTS / "verify-acp-processes.py"))
    pid = os.getpid()

    class ExitedProcess:
        def status(self):
            raise psutil.NoSuchProcess(pid)

    def lookup(_pid):
        if disappears_during == "lookup":
            raise psutil.NoSuchProcess(pid)
        return ExitedProcess()

    monkeypatch.setattr(psutil, "Process", lookup)
    asyncio.run(probe["gone"]([pid]))
