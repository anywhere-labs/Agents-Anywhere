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
