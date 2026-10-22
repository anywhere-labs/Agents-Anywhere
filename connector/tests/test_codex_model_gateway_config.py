from __future__ import annotations

import asyncio
import copy
from typing import Any

from openai_codex import JsonRpcError

from connector.runtimes.codex.sdk.client import CodexSdkClient
from connector.runtimes.model_gateway import ModelGateway

GATEWAY = ModelGateway(base_url="https://gateway.example/v1", api_key="secret-1")
PROVIDER = {
    "name": "Agents Anywhere Model Gateway",
    "base_url": "https://gateway.example/v1",
    "experimental_bearer_token": "secret-1",
    "wire_api": "responses",
    "requires_openai_auth": False,
}
OTHER_PROVIDER = {"name": "Mine", "base_url": "https://mine.example/v1"}


class _FakeConfigServer:
    """``config/read`` and ``config/value/write`` over one versioned user layer."""

    def __init__(
        self,
        user_config: dict[str, Any] | None = None,
        *,
        profile_config: dict[str, Any] | None = None,
        write_errors: tuple[Exception, ...] = (),
    ) -> None:
        self.user_config = copy.deepcopy(user_config or {})
        self.profile_config = profile_config
        self.version = 0
        self.write_errors = list(write_errors)
        self.requests: list[tuple[str, dict[str, Any]]] = []

    async def request(
        self,
        method: str,
        params: dict[str, Any],
        *,
        response_model: Any,
    ) -> Any:
        self.requests.append((method, copy.deepcopy(params)))
        if method == "config/read":
            layers: list[dict[str, Any]] = []
            if self.profile_config is not None:
                layers.append(
                    {
                        "name": {
                            "type": "user",
                            "file": "/home/.codex/work.config.toml",
                            "profile": "work",
                        },
                        "config": copy.deepcopy(self.profile_config),
                        "version": "profile",
                    }
                )
            layers += [
                {
                    "name": {
                        "type": "user",
                        "file": "/home/.codex/config.toml",
                        "profile": None,
                    },
                    "config": copy.deepcopy(self.user_config),
                    "version": f"v{self.version}",
                },
                {
                    "name": {"type": "system", "file": "/etc/codex/config.toml"},
                    "config": {},
                    "version": "system",
                },
            ]
            return response_model.model_validate(
                {"config": {}, "origins": {}, "layers": layers}
            )
        if method == "config/value/write":
            if self.write_errors:
                raise self.write_errors.pop(0)
            assert params["expectedVersion"] == f"v{self.version}"
            section, key = params["keyPath"].split(".", 1)
            table = self.user_config.setdefault(section, {})
            if params["value"] is None:
                table.pop(key, None)
            else:
                table[key] = params["value"]
            self.version += 1
            return response_model.model_validate(
                {
                    "filePath": "/home/.codex/config.toml",
                    "status": "ok",
                    "version": f"v{self.version}",
                }
            )
        raise AssertionError(f"unexpected request {method}")

    def methods(self) -> list[str]:
        return [method for method, _ in self.requests]


class _FakeNativeClient:
    def __init__(self, server: _FakeConfigServer) -> None:
        self._client = server


def _sync(server: _FakeConfigServer, gateway: ModelGateway | None) -> None:
    client = CodexSdkClient(_FakeNativeClient(server), model_gateway=gateway)
    asyncio.run(client.sync_model_gateway_provider())


def _conflict() -> JsonRpcError:
    return JsonRpcError(
        -32600,
        "Configuration was modified since last read. Fetch latest version and retry.",
        {"config_write_error_code": "configVersionConflict"},
    )


def test_gateway_provider_is_written_beside_existing_providers() -> None:
    server = _FakeConfigServer({"model_providers": {"mine": OTHER_PROVIDER}})

    _sync(server, GATEWAY)

    assert server.user_config["model_providers"] == {
        "mine": OTHER_PROVIDER,
        "agents_anywhere_gateway": PROVIDER,
    }
    assert server.requests[1] == (
        "config/value/write",
        {
            "keyPath": "model_providers.agents_anywhere_gateway",
            "value": PROVIDER,
            "mergeStrategy": "replace",
            "expectedVersion": "v0",
        },
    )


def test_matching_gateway_provider_is_not_rewritten() -> None:
    server = _FakeConfigServer({"model_providers": {"agents_anywhere_gateway": PROVIDER}})

    _sync(server, GATEWAY)

    assert server.methods() == ["config/read"]


def test_changed_gateway_key_replaces_the_whole_provider() -> None:
    stale = {**PROVIDER, "experimental_bearer_token": "old", "http_headers": {"X": "1"}}
    server = _FakeConfigServer({"model_providers": {"agents_anywhere_gateway": stale}})

    _sync(server, GATEWAY)

    assert server.user_config["model_providers"]["agents_anywhere_gateway"] == PROVIDER


def test_removed_gateway_deletes_only_the_provider_aa_wrote() -> None:
    server = _FakeConfigServer(
        {
            "model_providers": {
                "agents_anywhere_gateway": PROVIDER,
                "mine": OTHER_PROVIDER,
            }
        }
    )

    _sync(server, None)

    assert server.user_config["model_providers"] == {"mine": OTHER_PROVIDER}
    assert server.requests[1][1]["value"] is None


def test_removed_gateway_keeps_a_user_provider_with_the_same_id() -> None:
    own = {"name": "My own gateway", "base_url": "https://own.example/v1"}
    server = _FakeConfigServer({"model_providers": {"agents_anywhere_gateway": own}})

    _sync(server, None)

    assert server.methods() == ["config/read"]
    assert server.user_config["model_providers"]["agents_anywhere_gateway"] == own


def test_without_gateway_or_provider_nothing_is_written() -> None:
    server = _FakeConfigServer({"model": "gpt-5"})

    _sync(server, None)

    assert server.methods() == ["config/read"]


def test_profile_layer_does_not_count_as_the_base_config() -> None:
    server = _FakeConfigServer(
        {},
        profile_config={"model_providers": {"agents_anywhere_gateway": PROVIDER}},
    )

    _sync(server, GATEWAY)

    assert server.user_config["model_providers"]["agents_anywhere_gateway"] == PROVIDER


def test_concurrent_config_edit_is_read_again_before_writing() -> None:
    server = _FakeConfigServer({}, write_errors=(_conflict(),))

    _sync(server, GATEWAY)

    assert server.methods() == [
        "config/read",
        "config/value/write",
        "config/read",
        "config/value/write",
    ]
    assert server.user_config["model_providers"]["agents_anywhere_gateway"] == PROVIDER


def test_repeated_conflicts_give_up_without_raising() -> None:
    server = _FakeConfigServer({}, write_errors=(_conflict(),) * 3)

    _sync(server, GATEWAY)

    assert server.methods().count("config/value/write") == 3
    assert "model_providers" not in server.user_config


def test_config_write_failure_does_not_block_runtime_start() -> None:
    server = _FakeConfigServer(
        {},
        write_errors=(
            JsonRpcError(-32603, "failed to persist config.toml: access denied"),
        ),
    )
    client = CodexSdkClient(_FakeNativeClient(server), model_gateway=GATEWAY)

    async def handler(_: Any) -> None:
        return None

    async def scenario() -> None:
        await client.start(handler)
        await client.stop()

    asyncio.run(scenario())

    assert server.methods() == ["config/read", "config/value/write"]
    assert "model_providers" not in server.user_config
