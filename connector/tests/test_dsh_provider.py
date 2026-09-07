from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any

import pytest

from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeInvalidRequestError,
    RuntimeUnavailableError,
    RuntimeUnsupportedError,
    RuntimeUpstreamError,
)
from connector.runtimes.dsh.discovery import BridgeEndpoint, DshDiscovery, discover
from connector.runtimes.dsh.provider import DshProvider
from connector.runtimes.dsh.runtime import DshRuntime
from connector.runtimes.providers import default_runtime_providers


def test_dsh_is_third_default_provider() -> None:
    assert [provider.runtime for provider in default_runtime_providers()] == [
        "codex",
        "claude",
        "dsh",
    ]


def test_dsh_provider_identity_schema_and_validation(tmp_path: Path) -> None:
    endpoint_path = tmp_path / "home" / "agents-anywhere" / "bridge" / "endpoint.json"
    endpoint = BridgeEndpoint("127.0.0.1", 12345, "token", os.getpid(), endpoint_path)

    async def discover(values: dict[str, Any]) -> DshDiscovery:
        return DshDiscovery(
            available=True,
            configured=True,
            endpoint=endpoint,
            metadata={"profile": "web"},
        )

    async def run() -> None:
        provider = DshProvider(discoverer=discover)
        assert provider.runtime == "dsh"
        assert provider.runtime_type == "dsh"
        assert provider.implementation_type == "local-service"
        assert provider.instance_policy == "single"
        assert provider.max_instances == 1
        descriptor = await provider.discover()
        assert descriptor.instance_policy == "single"
        assert descriptor.max_instances == 1
        assert provider.display_name == "DeepSeek Harness"
        schema = await provider.get_config_schema()
        assert schema.defaults["maxRestartAttempts"] == 3

        config = await provider.validate_config(
            {
                **schema.defaults,
                "dshHome": str(tmp_path / "home"),
            }
        )
        assert config.runtime == "dsh"
        assert config.metadata["profile"] == "web"
        assert config.metadata["storageMode"] == "dsh-native"
        assert config.metadata["crossProcessWriterExclusion"] is False

        migrated = await provider.validate_config(
            {
                **schema.defaults,
                "dshHome": str(tmp_path / "home"),
                "executablePath": "/legacy/dsh",
                "profile": "aa",
                "environment": {"OLD": "value"},
                "shutdownTimeoutMs": 15_000,
                "killGraceMs": 5_000,
            }
        )
        assert migrated.values == config.values

        with pytest.raises(RuntimeInvalidRequestError):
            await provider.validate_config(
                {
                    **schema.defaults,
                    "dshHome": "relative/home",
                }
            )
        with pytest.raises(RuntimeInvalidRequestError):
            await provider.validate_config({**schema.defaults, "unexpected": True})

    asyncio.run(run())


def test_dsh_provider_canonicalizes_home_and_endpoint_claims(
    tmp_path: Path,
) -> None:
    async def run() -> None:
        real_home = tmp_path / "real-home"
        endpoint_path = real_home / "agents-anywhere" / "bridge" / "endpoint.json"
        endpoint_path.parent.mkdir(parents=True)
        endpoint = BridgeEndpoint(
            "127.0.0.1",
            12345,
            "secret-token",
            os.getpid(),
            endpoint_path,
        )

        async def discover(values: dict[str, Any]) -> DshDiscovery:
            return DshDiscovery(True, True, endpoint, metadata={})

        linked_home = tmp_path / "linked-home"
        linked_home.symlink_to(real_home, target_is_directory=True)
        provider = DshProvider(discoverer=discover)
        direct = await provider.validate_config(
            {"dshHome": str(real_home / ".." / "real-home")}
        )
        linked = await provider.validate_config({"dshHome": str(linked_home)})

        assert direct.values["dshHome"] == str(real_home.resolve())
        assert linked.values["dshHome"] == str(real_home.resolve())
        assert provider.resource_claims(direct) == provider.resource_claims(linked)
        source = provider.session_source_key(direct)
        assert source == provider.session_source_key(linked)
        assert "secret-token" not in source.key
        assert "12345" not in source.key
        assert str(os.getpid()) not in source.key

    asyncio.run(run())


@pytest.mark.skipif(sys.platform != "darwin", reason="Darwin path identity semantics")
def test_dsh_provider_blocks_case_and_unicode_path_aliases(tmp_path: Path) -> None:
    async def discover(values: dict[str, Any]) -> DshDiscovery:
        path = Path(str(values["dshHome"])) / "agents-anywhere/bridge/endpoint.json"
        return DshDiscovery(
            True,
            True,
            BridgeEndpoint("127.0.0.1", 12345, "token", os.getpid(), path),
            metadata={},
        )

    async def run() -> None:
        provider = DshProvider(discoverer=discover)
        composed = tmp_path / "DSH-Caf\u00e9"
        decomposed = tmp_path / "dsh-cafe\u0301"

        first = await provider.validate_config({"dshHome": str(composed)})
        second = await provider.validate_config({"dshHome": str(decomposed)})

        first_claims = provider.resource_claims(first)
        second_claims = provider.resource_claims(second)
        assert [(claim.kind, claim.key, claim.mode) for claim in first_claims] == [
            (claim.kind, claim.key, claim.mode) for claim in second_claims
        ]
        assert provider.session_source_key(first) == provider.session_source_key(second)

    asyncio.run(run())


class _Host:
    connector_id = "test"
    session_namespace = "test:instance"


class _Pages(DshRuntime):
    def __init__(self, pages):
        super().__init__(RuntimeConfig("dsh", 2), _Host())
        self.pages = iter(pages)
        self.calls = []

    async def _request(self, method, params=None):
        self.calls.append((method, params))
        return next(self.pages)


def test_inventory_pages_preserve_host_ids_and_sync_metadata() -> None:
    async def run() -> None:
        runtime = _Pages(
            [
                {
                    "sessions": [
                        {
                            "sessionId": "a",
                            "externalSessionId": "native-a",
                            "runtime": "dsh",
                            "metadata": {"sync": {"requires_timeline_sync": True}},
                        }
                    ],
                    "nextCursor": "page-2",
                },
                {
                    "sessions": [
                        {
                            "sessionId": "b",
                            "externalSessionId": "native-b",
                            "runtime": "dsh",
                        }
                    ]
                },
            ]
        )
        inventory = await runtime.list_complete_session_inventory(page_size=1)
        assert [item.session_id for item in inventory] == ["a", "b"]
        assert inventory[0].metadata["sync"]["requires_timeline_sync"] is True
        assert runtime.calls[1][1]["cursor"] == "page-2"

    asyncio.run(run())


@pytest.mark.parametrize(
    "pages",
    [
        [
            {"sessions": [], "nextCursor": "loop"},
            {"sessions": [], "nextCursor": "loop"},
        ],
        [
            {
                "sessions": [{"sessionId": "a", "externalSessionId": "a"}],
                "nextCursor": "next",
            },
            {"sessions": [{"sessionId": "a", "externalSessionId": "a"}]},
        ],
    ],
)
def test_inventory_rejects_incomplete_or_repeated_pages(pages) -> None:
    async def run() -> None:
        with pytest.raises(RuntimeUpstreamError):
            await _Pages(pages).list_complete_session_inventory()

    asyncio.run(run())


def test_snapshot_requires_all_pages_from_same_capture() -> None:
    async def run() -> None:
        base = {
            "sessionId": "a",
            "externalSessionId": "native-a",
            "items": [],
            "watermark": {"seq": 1},
            "snapshotComplete": True,
        }
        runtime = _Pages(
            [{**base, "nextCursor": "next"}, {**base, "watermark": {"seq": 2}}]
        )
        with pytest.raises(RuntimeUpstreamError, match="changed"):
            await runtime.get_session_snapshot("a", "native-a")
        runtime = _Pages([{**base, "metadata": {"totalItems": 1}}])
        with pytest.raises(RuntimeUpstreamError, match="missing"):
            await runtime.get_session_snapshot("a", "native-a")

    asyncio.run(run())


def test_text_runtime_requires_message_identity_and_does_not_expose_catalogs() -> None:
    async def run() -> None:
        runtime = _Pages([])
        for call in [runtime.list_model_catalog, runtime.list_permission_catalog]:
            with pytest.raises(RuntimeUnsupportedError):
                await call()
        with pytest.raises(RuntimeInvalidRequestError):
            await runtime.start_turn("a", "native-a", "hello")
        assert runtime.calls == []
        assert await runtime.get_session_notices("a") == ()

    asyncio.run(run())


def test_stale_or_invalid_endpoint_cannot_be_added(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("DSH_HOME", str(tmp_path))
    path = tmp_path / "agents-anywhere/bridge/endpoint.json"
    path.parent.mkdir(parents=True)

    async def run() -> None:
        assert not (await discover({})).available
        # A live process with a dead port is not an available runtime.
        path.write_text(
            json.dumps(
                {
                    "version": 1,
                    "host": "127.0.0.1",
                    "port": 1,
                    "pid": os.getpid(),
                    "token": "not-a-real-token",
                }
            )
        )
        assert not (await discover({})).available
        with pytest.raises(RuntimeInvalidRequestError):
            await DshProvider().validate_config({})

    asyncio.run(run())


def test_reads_retry_connection_after_bounded_recovery_is_exhausted() -> None:
    class Client:
        connected = True

        async def request(self, method, params):
            return {"sessions": []}

    class Runtime(DshRuntime):
        attempts = 0

        async def _start_client(self):
            self.attempts += 1
            if self.attempts == 1:
                raise ConnectionError("DSH restarting")
            self._client = Client()

    async def run() -> None:
        runtime = Runtime(RuntimeConfig("dsh", 2), _Host())
        with pytest.raises(RuntimeUnavailableError):
            await runtime.list_sessions()
        assert await runtime.list_sessions() == ()
        assert runtime.attempts == 2

    asyncio.run(run())
