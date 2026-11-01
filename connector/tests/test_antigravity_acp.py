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
