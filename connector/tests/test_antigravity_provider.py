from __future__ import annotations

import asyncio
from typing import Any

import pytest

from connector.runtime_protocol import RuntimeInvalidRequestError
from connector.runtimes.antigravity.provider import AntigravityProvider


def test_antigravity_provider_discovers_installed() -> None:
    asyncio.run(_test_antigravity_provider_discovers_installed())


async def _test_antigravity_provider_discovers_installed() -> None:
    def fake_checker() -> dict[str, Any]:
        return {
            "installed": True,
            "ls_running": True,
            "agentapi": "/path/to/agentapi",
            "db_exists": True,
            "pid": 1234,
            "ls_addr": "127.0.0.1:54052",
        }

    provider = AntigravityProvider(checker=fake_checker)
    item = await provider.discover()

    assert item.available is True
    assert item.runtime_type == "antigravity"
    assert item.instance_policy == "single"
    assert item.max_instances == 1
    assert item.capabilities["modelCatalog"] is True
    assert item.capabilities["sessionDiscovery"] is True
    assert item.capabilities["sessionSnapshot"] is True
    assert item.capabilities["sessionState"] is True
    assert item.capabilities["createAndStartSession"] is True
    assert item.capabilities["startTurn"] is True
    assert item.capabilities["permissionCatalog"] is False
    assert item.metadata["configured"] is True
    assert item.metadata["status"]["ls_running"] is True


def test_antigravity_provider_reports_unavailable_when_not_installed() -> None:
    asyncio.run(_test_antigravity_provider_reports_unavailable_when_not_installed())


async def _test_antigravity_provider_reports_unavailable_when_not_installed() -> None:
    def fake_checker() -> dict[str, Any]:
        return {
            "installed": False,
            "ls_running": False,
            "agentapi": None,
            "db_exists": False,
        }

    provider = AntigravityProvider(checker=fake_checker)
    item = await provider.discover()

    assert item.available is False
    assert item.reason == "Antigravity not found on system"


def test_antigravity_provider_validates_default_model() -> None:
    asyncio.run(_test_antigravity_provider_validates_default_model())


async def _test_antigravity_provider_validates_default_model() -> None:
    provider = AntigravityProvider(checker=lambda: {"installed": True})

    # Default to flash if not provided
    cfg = await provider.validate_config({})
    assert cfg.values["defaultModel"] == "flash"

    # Valid models
    for m in ("flash", "pro", "flash_lite"):
        cfg = await provider.validate_config({"defaultModel": m})
        assert cfg.values["defaultModel"] == m

    # Invalid models raise RuntimeInvalidRequestError
    for invalid in ("claude-opus-4-6", "gpt-4o", "gemini-3.1-pro", "unknown"):
        with pytest.raises(RuntimeInvalidRequestError):
            await provider.validate_config({"defaultModel": invalid})


def test_antigravity_provider_validates_and_normalizes_custom_models() -> None:
    asyncio.run(_test_antigravity_provider_validates_and_normalizes_custom_models())


async def _test_antigravity_provider_validates_and_normalizes_custom_models() -> None:
    provider = AntigravityProvider(checker=lambda: {"installed": True})

    cfg = await provider.validate_config(
        {
            "defaultModel": "pro",
            "customModels": [
                {"modelId": "custom-exp", "displayName": "Custom Experimental"},
            ],
        }
    )
    assert cfg.values["defaultModel"] == "pro"
    assert len(cfg.values["customModels"]) == 1
    assert cfg.values["customModels"][0]["modelId"] == "custom-exp"

    # Reject duplicate custom model IDs
    with pytest.raises(RuntimeInvalidRequestError):
        await provider.validate_config(
            {
                "customModels": [
                    {"modelId": "custom-exp", "displayName": "Model 1"},
                    {"modelId": "custom-exp", "displayName": "Model 2"},
                ],
            }
        )
