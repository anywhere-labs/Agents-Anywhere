import asyncio
import os
import sys
from pathlib import Path
from types import SimpleNamespace
import pytest

from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.providers import default_runtime_providers
from connector.runtimes.antigravity.provider import AntigravityProvider
from connector.runtimes.antigravity.discovery import AntigravityLaunch, discover_antigravity
from connector.runtimes.acp.runtime import AcpRuntime


def test_antigravity_provider_registered_in_default_providers():
    providers = default_runtime_providers()
    types = [p.runtime_type for p in providers]
    assert "antigravity" in types
    provider = next(p for p in providers if p.runtime_type == "antigravity")
    assert isinstance(provider, AntigravityProvider)


def test_antigravity_provider_discovery(monkeypatch, tmp_path):
    async def run():
        fake_bin = tmp_path / "antigravity"
        fake_bin.write_text("#!/bin/sh\necho ok", encoding="utf-8")
        fake_bin.chmod(0o755)
        monkeypatch.setattr(
            "connector.runtimes.antigravity.provider.discover_antigravity",
            lambda: AntigravityLaunch(str(fake_bin)),
        )
        provider = AntigravityProvider()
        desc = await provider.discover()
        assert desc.runtime_type == "antigravity"
        assert desc.available is True
        assert desc.display_name == "Antigravity"
        assert desc.capabilities.get("createAndStartSession") is True
        assert desc.capabilities.get("startTurn") is True
        # server 端 create-and-start 按这份快照门控附件，缺了会 409。
        assert desc.capabilities.get("attachments") is True

    asyncio.run(run())


def test_antigravity_provider_create_runtime(monkeypatch, tmp_path):
    async def run():
        fake_bin = tmp_path / "antigravity"
        fake_bin.write_text("#!/bin/sh\necho ok", encoding="utf-8")
        fake_bin.chmod(0o755)
        monkeypatch.setattr(
            "connector.runtimes.antigravity.provider.discover_antigravity",
            lambda: AntigravityLaunch(str(fake_bin)),
        )
        provider = AntigravityProvider()
        config = RuntimeConfig(runtime="antigravity", revision=1, values={}, schema={})
        host = SimpleNamespace(
            session_namespace="test-ag",
            runtime_kv=SimpleNamespace(path=tmp_path / "kv/runtime.json"),
            publish_runtime_notifications=lambda *args, **kwargs: None,
            runtime_id="antigravity",
        )
        runtime = await provider.create_runtime(config, host)
        assert isinstance(runtime, AcpRuntime)
        assert runtime.profile.id == "antigravity"
        assert runtime.profile.title == "Antigravity"
        env = dict(runtime.launch.environment)
        assert env.get("ANTIGRAVITY_BIN") == str(fake_bin)
        assert str(fake_bin.parent) in env.get("PATH", "")

    asyncio.run(run())


def test_antigravity_config_options_map_legacy_selections():
    """App 发送的 model/permission 选择必须能唯一映射到 bridge 的配置项。"""
    from connector.runtimes.acp.application.configuration import ConfigurationService
    from connector.runtimes.acp.domain.catalogs import selection_id
    from connector.runtimes.antigravity.bridge import _config_options

    class MemStore:
        def __init__(self):
            self.rows = {}

        def get(self, kind, key):
            return self.rows.get((kind, key))

        def put(self, kind, key, value):
            self.rows[(kind, key)] = value

    service = ConfigurationService(MemStore())
    options = [
        option.model_dump(by_alias=True, exclude_none=True)
        for option in _config_options()
    ]
    service.observe("sess-1", options)
    snapshot = service.snapshot("sess-1")
    categories = {}
    for option in snapshot.options:
        categories.setdefault(option["category"], []).append(option["id"])
    assert categories["model"] == ["model"]
    assert categories["effort"] == ["reasoning_effort"]
    assert categories["permission"] == ["permission"]

    # 两种模型选择形态：裸 id 与 acp-selection 编码（含 effort）。
    merged = snapshot.merge_legacy({}, {"model": "gemini-3.8-flash", "permission": "default"})
    assert merged["model"] == "gemini-3.8-flash"
    assert merged["permission"] == "default"
    assert "reasoning_effort" not in merged

    encoded = selection_id("claude-sonnet-4-6", "high")
    merged2 = snapshot.merge_legacy({}, {"model": encoded, "permission": "bypassPermissions"})
    assert merged2["model"] == "claude-sonnet-4-6"
    assert merged2["reasoning_effort"] == "high"
    assert merged2["permission"] == "bypassPermissions"


def test_antigravity_bridge_proxy_resolution(monkeypatch):
    """CLI 不读 macOS 系统代理，bridge 必须为子进程补代理环境。"""
    from connector.runtimes.antigravity import bridge

    monkeypatch.setenv("ANTIGRAVITY_CLI_PROXY", "http://127.0.0.1:9999")
    assert bridge.resolve_proxy() == "http://127.0.0.1:9999"
    env = bridge.cli_environment()
    assert env["HTTPS_PROXY"] == "http://127.0.0.1:9999"
    assert env["https_proxy"] == "http://127.0.0.1:9999"

    # 无显式变量时探测本机端口（测试里用 monkeypatch 模拟探测结果）。
    monkeypatch.delenv("ANTIGRAVITY_CLI_PROXY")
    for key in ("HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(
        bridge,
        "LOCAL_PROXY_PORTS",
        (),
    )
    assert bridge.resolve_proxy() is None


def test_antigravity_profile_declares_attachment_capability(monkeypatch, tmp_path):
    """新建任务界面按 runtime.attachment 能力放行附件；profile 必须声明。"""
    from connector.runtimes.providers import default_runtime_providers

    fake_bin = tmp_path / "antigravity"
    fake_bin.write_text("#!/bin/sh\necho ok", encoding="utf-8")
    fake_bin.chmod(0o755)
    monkeypatch.setattr(
        "connector.runtimes.antigravity.provider.discover_antigravity",
        lambda: AntigravityLaunch(str(fake_bin)),
    )
    provider = next(
        p for p in default_runtime_providers() if p.runtime_type == "antigravity"
    )

    async def run():
        config = RuntimeConfig(runtime="antigravity", revision=1, values={}, schema={})
        host = SimpleNamespace(
            session_namespace="test-ag",
            runtime_kv=SimpleNamespace(path=tmp_path / "kv/runtime.json"),
            publish_runtime_notifications=lambda *args, **kwargs: None,
            runtime_id="antigravity",
        )
        runtime = await provider.create_runtime(config, host)
        assert "runtime.attachment" in runtime.profile.runtime_capabilities
        capability_set = await runtime.get_runtime_capabilities()
        ids = [item.capability_id for item in capability_set.capabilities]
        assert "runtime.attachment" in ids

    asyncio.run(run())


def test_antigravity_client_declares_attachment_capability(monkeypatch, tmp_path):
    """会话级附件门控读 client._meta.aa.capabilities；客户端必须声明。"""
    from connector.runtimes.antigravity.provider import AntigravityClient

    fake_bin = tmp_path / "antigravity"
    fake_bin.write_text("#!/bin/sh\nsleep 0.1", encoding="utf-8")
    fake_bin.chmod(0o755)
    launch = AntigravityLaunch(str(fake_bin))
    client = AntigravityClient(lambda *args: None, lambda *args: None)

    async def run():
        # 跳过真实 ACP 握手：只验证 start() 后的能力登记。
        async def fake_start(self, launch_def, cwd):
            self.capabilities = {"agentCapabilities": {}}
            return self.capabilities

        monkeypatch.setattr(
            "connector.runtimes.acp.infrastructure.acp.client.AgentClient.start",
            fake_start,
        )
        await client.start(launch, str(tmp_path))
        aa = client.capabilities.get("_meta", {}).get("aa", {})
        assert "runtime.attachment" in aa.get("capabilities", [])

    asyncio.run(run())


def test_antigravity_bridge_prompt_blocks_materialize(monkeypatch, tmp_path):
    """图片块落盘成文件、资源块解析本机路径，供 --print 提示词引用。"""
    import base64

    from connector.runtimes.antigravity import bridge

    monkeypatch.setattr(bridge, "tempfile", __import__("tempfile"))
    monkeypatch.setattr(
        bridge,
        "_attachments_dir",
        lambda session_id: tmp_path / "attachments" / session_id,
    )

    png = base64.b64encode(b"\x89PNG-fake").decode()
    image_block = {
        "type": "image",
        "data": png,
        "mimeType": "image/png",
        "_meta": {"aa": {"attachment": {"name": "shot.png"}}},
    }
    local_file = tmp_path / "cached" / "report.txt"
    local_file.parent.mkdir(parents=True)
    local_file.write_text("hello", encoding="utf-8")
    resource_block = {
        "type": "resource_link",
        "uri": local_file.as_uri(),
        "name": "report.txt",
        "mimeType": "text/plain",
        "size": 5,
    }

    text_parts, attachments = bridge._parse_prompt_blocks(
        "sess-1", ["plain str", {"text": "dict text"}, image_block, resource_block]
    )
    assert text_parts == ["plain str", "dict text"]
    assert len(attachments) == 2

    image_info = next(a for a in attachments if a["media_type"] == "image/png")
    assert image_info["name"] == "shot.png"
    assert image_info["path"].read_bytes() == b"\x89PNG-fake"

    file_info = next(a for a in attachments if a["media_type"] == "text/plain")
    assert file_info["path"] == local_file
    assert file_info["size"] == 5

    note = bridge._attachment_note(attachments)
    assert "shot.png" in note
    assert str(image_info["path"]) in note
    assert str(local_file) in note


def test_antigravity_bridge_prompt_appends_attachment_note(monkeypatch, tmp_path):
    """prompt() 将附件路径写进 --print 文本，Agent 据此读取文件。"""
    import base64

    from connector.runtimes.antigravity import bridge

    captured = {}

    class FakeProc:
        def __init__(self, cmd, **kwargs):
            captured["cmd"] = cmd
            self.stdout = iter(())

        def wait(self):
            return 0

    monkeypatch.setattr(bridge.subprocess, "Popen", FakeProc)
    monkeypatch.setattr(
        bridge,
        "discover_antigravity",
        lambda: AntigravityLaunch("/usr/bin/true"),
    )
    monkeypatch.setattr(
        bridge,
        "_attachments_dir",
        lambda session_id: tmp_path / "attachments" / session_id,
    )

    png = base64.b64encode(b"\x89PNG-fake").decode()
    agent = bridge.AntigravityAgent()
    asyncio.run(
        agent.prompt(
            "sess-1",
            [
                {"text": "请修复截图里的问题"},
                {"type": "image", "data": png, "mimeType": "image/png",
                 "_meta": {"aa": {"attachment": {"name": "bug.png"}}}},
            ],
        )
    )
    print_index = captured["cmd"].index("--print")
    prompt_text = captured["cmd"][print_index + 1]
    assert "请修复截图里的问题" in prompt_text
    assert "bug.png" in prompt_text
    assert "[附件]" in prompt_text
    # 附件目录必须进工作区，Agent 文件工具才读得到。
    add_dirs = [
        captured["cmd"][i + 1]
        for i, arg in enumerate(captured["cmd"])
        if arg == "--add-dir"
    ]
    assert str(tmp_path / "attachments" / "sess-1") in add_dirs
