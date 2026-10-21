from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

import pytest

from connector.core import runtime_owner
from connector.runtime_protocol import (
    RuntimeConfig,
    RuntimeInvalidRequestError,
    RuntimeUnavailableError,
    RuntimeUpstreamError,
)
from connector.runtime_protocol.filesystem import (
    canonical_path,
    filesystem_resource_key,
)
from connector.runtimes.dsh import provider_config
from connector.runtimes.dsh.bridge import client as bridge_client_module
from connector.runtimes.dsh.bridge import host as bridge_host_module
from connector.runtimes.dsh.bridge.client import (
    BridgeRpcError,
    BridgeUnavailableError,
)
from connector.runtimes.dsh.discovery import DshDiscovery, discover, probe
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
    async def discoverer(_values: dict[str, Any]) -> DshDiscovery:
        return DshDiscovery(available=True, configured=True, metadata={"profile": "web"})

    async def run() -> None:
        provider = DshProvider(discoverer=discoverer)
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


def test_dsh_provider_canonicalizes_home_claims(tmp_path: Path) -> None:
    async def discoverer(_values: dict[str, Any]) -> DshDiscovery:
        return DshDiscovery(True, True, metadata={})

    async def run() -> None:
        real_home = tmp_path / "real-home"
        real_home.mkdir()
        linked_home = tmp_path / "linked-home"
        linked_home.symlink_to(real_home, target_is_directory=True)
        provider = DshProvider(discoverer=discoverer)
        direct = await provider.validate_config(
            {"dshHome": str(real_home / ".." / "real-home")}
        )
        linked = await provider.validate_config({"dshHome": str(linked_home)})

        assert direct.values["dshHome"] == str(real_home.resolve())
        assert linked.values["dshHome"] == str(real_home.resolve())
        assert provider.resource_claims(direct) == provider.resource_claims(linked)
        assert provider.session_source_key(direct) == provider.session_source_key(linked)

    asyncio.run(run())


@pytest.mark.skipif(sys.platform != "darwin", reason="Darwin path identity semantics")
def test_dsh_provider_blocks_case_and_unicode_path_aliases(tmp_path: Path) -> None:
    async def discoverer(_values: dict[str, Any]) -> DshDiscovery:
        return DshDiscovery(True, True, metadata={})

    async def run() -> None:
        provider = DshProvider(discoverer=discoverer)
        composed = tmp_path / "DSH-Café"
        decomposed = tmp_path / "dsh-café"

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


def test_text_runtime_requires_message_identity_and_forwards_catalogs() -> None:
    async def run() -> None:
        runtime = _Pages([{"runtime": "dsh", "revision": 3, "models": []}, {"runtime": "dsh", "revision": 3, "permissions": []}])
        assert (await runtime.list_model_catalog()).models == ()
        assert (await runtime.list_permission_catalog()).permissions == ()
        assert [method for method, _ in runtime.calls] == ["listModels", "listPermissions"]
        runtime.calls.clear()
        with pytest.raises(RuntimeInvalidRequestError):
            await runtime.start_turn("a", "native-a", "hello")
        assert runtime.calls == []
        assert await _Pages([{"notices": []}]).get_session_notices("a") == ()

    asyncio.run(run())


def test_dsh_questions_forward_existing_notices_and_answers_without_reinterpretation() -> None:
    async def run() -> None:
        input_spec = {"required": True, "uiSchema": {
            "component": "inputRequest", "version": 1,
            "questions": [{"id": "q", "prompt": "选择", "multiple": False,
                           "allowCustom": True, "options": [{"id": "o_0", "label": "好"}]}],
        }}
        runtime = _Pages([
            {"notices": [{"noticeId": "question-1", "sessionId": "a", "runtime": "dsh",
                          "type": "interaction", "interactionType": "input_request", "title": "需要你的回答",
                          "status": "open", "responseRequired": True,
                          "blocking": {"scope": "session", "targetId": "a"},
                          "actions": [{"actionId": "submit", "label": "提交回答", "input": input_spec}]}]},
            {"ok": True, "result": {"resolved": True}},
            {"ok": False, "code": "dsh_question_not_pending", "message": "已处理"},
        ])
        notices = await runtime.get_session_notices("a", "native-a")
        assert notices[0].interaction_type == "input_request"
        assert notices[0].actions[0]["input"] == input_spec
        assert notices[0].blocking == {"scope": "session", "targetId": "a"}
        answer = {"answers": {"q": {"optionIds": ["o_0"]}}}
        result = await runtime.respond_interaction("a", "question-1", "submit", answer)
        assert result.ok and result.result == {"resolved": True}
        assert runtime.calls == [
            ("getSessionNotices", {"sessionId": "a", "externalSessionId": "native-a"}),
            ("respondInteraction", {"sessionId": "a", "noticeId": "question-1", "actionId": "submit", "inputData": answer}),
        ]
        result = await runtime.respond_interaction("a", "question-1", "cancel")
        assert not result.ok and result.code == "dsh_question_not_pending"

    asyncio.run(run())


def test_rendezvous_is_fixed_in_aa_home_while_session_identity_keeps_the_legacy_key(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("DSH_HOME", str(tmp_path / "env-dsh"))
    home = tmp_path / "custom-dsh"

    async def ready(_values: dict[str, Any]) -> DshDiscovery:
        return DshDiscovery(True, True, metadata={})

    provider = DshProvider(prober=ready)
    config = asyncio.run(provider.validate_config({"dshHome": str(home)}))

    rendezvous = Path(
        canonical_path(runtime_owner.system_home() / ".agents-anywhere/dsh-bridge/connector.json")
    )
    assert provider_config.bridge_directory() == rendezvous.parent
    assert provider_config.endpoint_path() == rendezvous
    endpoint_claim = next(claim for claim in provider.resource_claims(config) if claim.kind == "dsh_bridge_endpoint")
    assert endpoint_claim.key == filesystem_resource_key(provider_config.endpoint_path())
    # Session namespaces hash the 1.x endpoint location, not the 2.0 rendezvous,
    # so existing session IDs stay stable.
    legacy = home / "agents-anywhere" / "bridge" / "endpoint.json"
    assert provider_config.legacy_endpoint_path(dict(config.values)) == Path(canonical_path(legacy))
    assert provider.session_source_key(config).key == filesystem_resource_key(legacy)


def test_discovery_reports_support_without_touching_the_bridge() -> None:
    async def run() -> None:
        supported = await discover({})
        assert supported.available is True
        assert supported.configured is True
        assert supported.reason is None
        assert supported.metadata["endpoint"] == str(provider_config.endpoint_path())
        assert supported.metadata["storageMode"] == "dsh-native"
        assert supported.metadata["sameSessionWriterLimit"] == 1
        assert supported.metadata["crossProcessWriterExclusion"] is False

    asyncio.run(run())


class _FakePluginClient:
    """The BridgeClient surface discovery.probe uses."""

    def __init__(
        self,
        responses: dict[str, Any] | None = None,
        *,
        start_error: Exception | None = None,
    ) -> None:
        self.responses = responses or {}
        self.start_error = start_error
        self.calls: list[tuple[str, Any]] = []
        self.closed = False

    async def start(self) -> dict[str, Any]:
        self.calls.append(("start", None))
        if self.start_error is not None:
            raise self.start_error
        return {"identity": {
            "runtime": "dsh", "runtimeVersion": "test",
            "protocolVersion": "2.0", "bridgeVersion": "1.4.0",
        }}

    async def request(self, method: str, params: Any = None) -> dict[str, Any]:
        self.calls.append((method, params))
        if method not in self.responses:
            raise AssertionError(f"unexpected method {method}")
        value = self.responses[method]
        if isinstance(value, Exception):
            raise value
        return value

    async def close(self) -> None:
        self.closed = True


def _patch_bridge(monkeypatch, client: _FakePluginClient, *, host_error: Exception | None = None) -> None:
    async def fake_bridge_host():
        if host_error is not None:
            raise host_error
        return SimpleNamespace()

    monkeypatch.setattr(bridge_host_module, "bridge_host", fake_bridge_host)
    monkeypatch.setattr(bridge_client_module, "BridgeClient", lambda _host, **_kwargs: client)


def test_probe_reports_the_registered_plugin_and_optional_catalogs(monkeypatch) -> None:
    async def run() -> None:
        client = _FakePluginClient({
            "ping": {"ok": True},
            "getRuntimeCapabilities": {
                "runtime": "dsh", "revision": 1,
                "capabilities": [{"capabilityId": "session.send_message", "supported": True, "available": True, "allowed": True}],
            },
            "listAgentPresets": {"presets": [{"id": "default", "enabled": True}]},
        })
        _patch_bridge(monkeypatch, client)

        result = await probe({"dshHome": "/ignored"})

        assert result.available is True and result.configured is True
        assert result.bridge_version == "1.4.0"
        assert result.metadata["runtimeCapabilities"]["revision"] == 1
        assert result.metadata["agentPresetCatalog"] == {"presets": [{"id": "default", "enabled": True}]}
        assert result.metadata["endpoint"] == str(provider_config.endpoint_path())
        assert result.metadata["storageMode"] == "dsh-native"
        assert client.closed is True
        assert [method for method, _ in client.calls] == [
            "start", "ping", "getRuntimeCapabilities", "listAgentPresets",
        ]

    asyncio.run(run())


def test_probe_keeps_a_read_only_plugin_discoverable(monkeypatch) -> None:
    async def run() -> None:
        client = _FakePluginClient({
            "ping": {"ok": True},
            "getRuntimeCapabilities": BridgeRpcError("METHOD_NOT_FOUND", "read-only plugin"),
            "listAgentPresets": BridgeRpcError("METHOD_NOT_FOUND", "read-only plugin"),
        })
        _patch_bridge(monkeypatch, client)

        result = await probe({})

        assert result.available is True and result.configured is True
        assert "runtimeCapabilities" not in result.metadata
        assert "agentPresetCatalog" not in result.metadata
        assert client.closed is True

    asyncio.run(run())


def test_probe_reports_offline_when_no_plugin_is_registered(monkeypatch) -> None:
    async def run() -> None:
        client = _FakePluginClient(start_error=BridgeUnavailableError("no plugin on the router"))
        _patch_bridge(monkeypatch, client)

        result = await probe({})

        assert result.available is False and result.configured is False
        assert result.reason == "请启动 DSH，并启用手机连接插件。"
        assert client.closed is True

    asyncio.run(run())


def test_probe_reports_a_local_router_start_failure(monkeypatch) -> None:
    async def run() -> None:
        client = _FakePluginClient()
        _patch_bridge(monkeypatch, client, host_error=RuntimeError("router cannot start"))

        result = await probe({})

        assert result.available is False and result.configured is False
        assert result.reason.startswith("无法启动本机 Router")
        assert "router cannot start" in result.reason
        assert client.closed is False

    asyncio.run(run())


def test_offline_probe_still_yields_a_valid_config() -> None:
    async def prober(_values: dict[str, Any]) -> DshDiscovery:
        return DshDiscovery(False, False, reason="请启动 DSH，并启用手机连接插件。")

    async def run() -> None:
        config = await DshProvider(prober=prober).validate_config({})
        assert config.runtime == "dsh"
        assert config.metadata["configured"] is False

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


def test_initial_catalog_error_does_not_close_other_runtime_requests(monkeypatch):
    from connector.runtimes.dsh import runtime as runtime_module

    async def run():
        broken = True

        async def request(method, params=None):
            if method == "getRuntimeCapabilities":
                return {"runtime": "dsh", "revision": 1, "capabilities": [
                    {"capabilityId": name, "supported": True, "available": True, "allowed": True}
                    for name in ["session.send_message", "catalog.model"]
                ]}
            if method == "listModels":
                if broken:
                    raise BridgeRpcError("INTERNAL", "catalog failed", retryable=True)
                return {"runtime": "dsh", "revision": 1, "models": []}
            if method == "ping":
                return {"ok": True}
            raise AssertionError(method)

        client = SimpleNamespace(connected=True, request=request, close=AsyncMock(), start=AsyncMock(return_value={
            "identity": {"runtime": "dsh", "runtimeVersion": "test", "protocolVersion": "2.0"},
            "features": {"syncMode": "polling"},
        }))

        async def fake_bridge_host():
            return SimpleNamespace()

        monkeypatch.setattr(runtime_module, "bridge_host", fake_bridge_host)
        monkeypatch.setattr(runtime_module, "BridgeClient", lambda _host, **_kwargs: client)
        host = SimpleNamespace(
            connector_id="test", runtime_capabilities_update=AsyncMock(),
            model_catalog_update=AsyncMock(), runtime_health_update=AsyncMock(),
        )
        runtime = DshRuntime(RuntimeConfig("dsh", 2), host)
        try:
            await runtime.start()
            health = host.runtime_health_update.await_args_list
            assert [call.args[0] for call in health] == ["starting", "running"]
            # Sync progress is a phase of "starting", never an error payload.
            assert health[0].args[1:] == ()
            assert health[0].kwargs["phase"]["code"] == "connecting"
            assert await runtime._request("ping") == {"ok": True}
            client.close.assert_not_awaited()
            broken = False
            assert (await runtime.list_model_catalog()).models == ()
            assert runtime._client is client
        finally:
            await runtime.stop()

    asyncio.run(run())
