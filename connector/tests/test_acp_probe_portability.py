import asyncio
import hashlib
import json
import os
import runpy
import sys
from pathlib import Path

import psutil
import pytest

from connector.runtimes.acp.domain.definitions import LaunchDefinition
from connector.runtimes.acp.infrastructure.acp.client import AgentClient
from connector.runtimes.acp.profiles.pi import adapter
from connector.runtimes.acp.profiles.pi.installation import history_directories

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


@pytest.fixture
def windows_text_locale(monkeypatch):
    original = Path.open

    def open_path(path, mode="r", *args, **kwargs):
        if "b" not in mode and kwargs.get("encoding") in (None, "locale"):
            kwargs["encoding"] = "cp1252"
        return original(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", open_path)


def test_adapter_cache_preserves_utf8_under_windows_locale(
    tmp_path, monkeypatch, windows_text_locale
):
    package = tmp_path / "node_modules/@openma/pi-acp"
    dist = package / "dist"
    dist.mkdir(parents=True)
    (package / "package.json").write_text(
        json.dumps(
            {"version": "0.1.8", "description": "中文适配器"}, ensure_ascii=False
        ),
        encoding="utf-8",
    )
    source = """import {} from "@earendil-works/pi-coding-agent";
async function findSession(sessionId, sessionDir) { return {}; }
class Session {
  async prompt(params) { return {}; }
  loading(session) { return {extensions: session.extensions(),}; }
"""
    for method in ("load", "resume", "fork"):
        source += f"""  async {method}() {{
    await this.requireModel(session).catch((error) => {{
      throw error;
    }});
  }}
"""
    source += "}\n// 中文适配器\n"
    files = {"bin.js": 'export const title = "中文入口";\n', "chunk-fixture.js": source}
    for name, content in files.items():
        (dist / name).write_text(content, encoding="utf-8", newline="\n")
    monkeypatch.setattr(
        adapter,
        "RELEASE_FILES",
        {
            name: hashlib.sha256(content.encode("utf-8")).hexdigest()
            for name, content in files.items()
        },
    )
    sdk = tmp_path / "中文 SDK"
    entry, metadata = adapter.prepare_adapter(dist / "bin.js", sdk, tmp_path / "cache")
    bridge = (entry.parent.parent / "sdk-bridge.mjs").read_bytes()
    assert "原生历史" in bridge.decode("utf-8")
    assert b"\r\n" not in bridge
    assert (sdk / "dist/index.js").as_uri() in bridge.decode("utf-8")
    assert "中文入口" in entry.read_bytes().decode("utf-8")
    assert adapter.prepare_adapter(dist / "bin.js", sdk, tmp_path / "cache") == (
        entry,
        metadata,
    )


def test_native_history_directory_setting_preserves_unicode_under_windows_locale(
    tmp_path, windows_text_locale
):
    extra = tmp_path / "原生历史"
    (tmp_path / "settings.json").write_text(
        json.dumps({"sessionDir": str(extra)}, ensure_ascii=False), encoding="utf-8"
    )
    assert extra.resolve() in history_directories({}, tmp_path)
