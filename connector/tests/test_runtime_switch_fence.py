from __future__ import annotations

import asyncio
import hashlib
import json
import stat
from collections.abc import Mapping
from pathlib import Path
from typing import Any

import pytest

from connector.core.config import ConnectorConfig
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeConfig,
    RuntimeConfigSchema,
    RuntimeHostClient,
    RuntimeIdentity,
    RuntimeInvalidRequestError,
    RuntimeProtocolError,
    RuntimeProvider,
    RuntimeSupervisor,
    RuntimeTypeDescriptor,
)
from connector.runtime_protocol.errors import RuntimeUnavailableError
from connector.runtime_protocol.model_connection import (
    ModelConnectionCapability,
    ModelConnectionStatus,
)
from connector.runtime_protocol.model_probe import ModelProbeResult
from connector.runtime_protocol.switch_fence import (
    CONNECTOR_PROCESS_INSTANCE_ID,
    RuntimeSwitchFenceStore,
    RuntimeSwitchRequest,
    SwitchRevisionStaleError,
    model_connection_digest,
)
from connector.runtimes.codex.provider import MODEL_CONNECTION as CODEX_MODEL_CONNECTION
from connector.server.client import BackendRpcClient, runtime_switch_directory
from connector.server.rpc import ConnectorRpcChannel
from connector.server.runtime_rpc import RuntimeRpcHandler
from connector.server.runtime_rpc_params import RuntimeConfigParams

RUNTIME_ID = "rti_codex_switch"


def server_connection_digest(
    config: dict[str, Any] | None,
    capability: dict[str, Any] | None,
) -> str | None:
    """Copy of the Server's ``connection_digest`` the Connector must match."""

    if not isinstance(config, dict) or not isinstance(capability, dict):
        return None
    gateway = config.get(str(capability.get("configField") or ""))
    if not isinstance(gateway, dict) or not gateway.get("baseUrl"):
        return None
    models_field = capability.get("modelsField")
    material = {
        "gateway": gateway,
        "models": config.get(models_field) if isinstance(models_field, str) else None,
    }
    encoded = json.dumps(material, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def gateway_config(api_key: str = "sk-test-1", model: str = "gpt-5") -> dict[str, Any]:
    return {
        "modelGateway": {"baseUrl": "https://gateway.example/v1", "apiKey": api_key},
        "customModels": [{"id": model, "name": "模型 Ünïcode"}],
        "model": {"modelId": model},
    }


class _Host(RuntimeHostClient):
    @property
    def connector_id(self) -> str:
        return "conn_switch"


class _Runtime(AgentRuntime):
    def __init__(self, config: RuntimeConfig) -> None:
        self.config = config
        self.starts = 0
        self.stops = 0
        self.model_setting_applied = False

    @property
    def identity(self) -> RuntimeIdentity:
        return RuntimeIdentity(runtime=self.config.runtime, runtime_version="test")

    async def start(self) -> None:
        self.starts += 1

    async def stop(self) -> None:
        self.stops += 1

    async def apply_model_setting(self, config: RuntimeConfig) -> bool:
        self.config = config
        self.model_setting_applied = True
        return True

    async def get_config(self) -> RuntimeConfig:
        return self.config


class _Provider(RuntimeProvider):
    """Codex-like provider; ``declare`` controls the provider-level capability."""

    def __init__(self, *, declare: bool = True) -> None:
        self.declare = declare
        self.created: list[_Runtime] = []
        self.fail_start = False

    @property
    def runtime_type(self) -> str:
        return "codex"

    @property
    def display_name(self) -> str:
        return "Codex"

    @property
    def model_connection(self) -> ModelConnectionCapability | None:
        return CODEX_MODEL_CONNECTION if self.declare else None

    async def discover(self) -> RuntimeTypeDescriptor:
        return RuntimeTypeDescriptor(
            runtime_type="codex",
            display_name="Codex",
            available=True,
            config_schema=await self.get_config_schema(),
            model_connection=CODEX_MODEL_CONNECTION,
        )

    async def get_config_schema(self) -> RuntimeConfigSchema:
        return RuntimeConfigSchema(runtime="codex", revision=1, schema={"type": "object"})

    async def validate_config(self, values: Mapping[str, Any]) -> RuntimeConfig:
        return RuntimeConfig(runtime="codex", revision=1, values=dict(values))

    async def create_runtime(self, config: RuntimeConfig, host: RuntimeHostClient) -> AgentRuntime:
        if self.fail_start:
            raise RuntimeError("start boom")
        runtime = _Runtime(config)
        self.created.append(runtime)
        return runtime

    def model_connection_status(self, config: RuntimeConfig) -> ModelConnectionStatus | None:
        return None


def _supervisor(
    directory: Path | None = None,
    provider: _Provider | None = None,
) -> tuple[RuntimeRpcHandler, RuntimeSupervisor, _Provider]:
    provider = provider or _Provider()
    host = _Host()
    supervisor = RuntimeSupervisor(
        providers=(provider,),
        host=host,
        switch_fence=RuntimeSwitchFenceStore(directory),
    )
    return RuntimeRpcHandler(supervisor, host), supervisor, provider


def _params(
    config: dict[str, Any] | None = None,
    *,
    revision: int | None = None,
    operation_id: str | None = None,
    config_revision: int = 1,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "runtime": "codex",
        "runtimeId": RUNTIME_ID,
        "name": "Switch Codex",
        "config": gateway_config() if config is None else config,
        "configRevision": config_revision,
    }
    if revision is not None:
        params["switchRevision"] = revision
    if operation_id is not None:
        params["operationId"] = operation_id
    return params


# -- params -----------------------------------------------------------------


def test_config_params_accept_switch_fields_and_keep_old_requests_working() -> None:
    legacy = RuntimeConfigParams.parse(_params())
    assert legacy.switch is None

    fenced = RuntimeConfigParams.parse(_params(revision=3, operation_id="op_3"))
    assert fenced.switch == RuntimeSwitchRequest(operation_id="op_3", switch_revision=3)

    longest = RuntimeConfigParams.parse(_params(revision=1, operation_id="o" * 128))
    assert longest.switch is not None


@pytest.mark.parametrize(
    ("overrides", "error", "match"),
    [
        ({"switchRevision": 2}, RuntimeInvalidRequestError, "sent together"),
        ({"operationId": "op"}, RuntimeInvalidRequestError, "sent together"),
        ({"operationId": "o" * 129, "switchRevision": 2}, ValueError, "operationId"),
        ({"operationId": "", "switchRevision": 2}, ValueError, "operationId"),
        ({"operationId": 7, "switchRevision": 2}, ValueError, "operationId"),
        ({"operationId": "op", "switchRevision": 0}, ValueError, "switchRevision"),
        ({"operationId": "op", "switchRevision": True}, TypeError, "switchRevision"),
        ({"operationId": "op", "switchRevision": 2**53}, ValueError, "switchRevision"),
    ],
)
def test_config_params_reject_invalid_switch_fields(
    overrides: dict[str, Any],
    error: type[Exception],
    match: str,
) -> None:
    with pytest.raises(error, match=match):
        RuntimeConfigParams.parse({**_params(), **overrides})


# -- discovery and digest -----------------------------------------------------


def test_discover_advertises_switch_fence() -> None:
    async def run() -> None:
        handler, *_ = _supervisor()
        discovered = await handler.dispatch("runtime.discover", {})
        assert discovered["features"] == ["switchFence", "modelProbe"]

    asyncio.run(run())


def test_digest_matches_server_algorithm() -> None:
    capability = CODEX_MODEL_CONNECTION.payload()
    for config in (
        gateway_config(),
        {"modelGateway": {"baseUrl": "https://g.example", "apiKey": "k"}},
        {"modelGateway": {"baseUrl": "https://g.example", "apiKey": "k"}, "customModels": []},
    ):
        expected = server_connection_digest(config, capability)
        assert expected is not None
        assert model_connection_digest(config, CODEX_MODEL_CONNECTION) == expected

    assert model_connection_digest({}, CODEX_MODEL_CONNECTION) is None
    assert model_connection_digest({"modelGateway": {"apiKey": "k"}}, CODEX_MODEL_CONNECTION) is None
    assert model_connection_digest(gateway_config(), None) is None


def test_start_result_reports_config_digest_and_instance_id() -> None:
    async def run() -> None:
        handler, supervisor, _provider = _supervisor()
        config = gateway_config()
        started = await handler.dispatch(
            "runtime.start", _params(config, revision=1, operation_id="op_1")
        )

        assert started["status"] == "running"
        assert started["configDigest"] == server_connection_digest(
            config, CODEX_MODEL_CONNECTION.payload()
        )
        assert started["instanceId"] == CONNECTOR_PROCESS_INSTANCE_ID
        assert started["instanceId"] == supervisor.instance_id

        # A runtime without a model connection reports null.
        no_gateway = await handler.dispatch("runtime.start", _params({"model": None}))
        assert no_gateway["configDigest"] is None

    asyncio.run(run())


def test_digest_uses_discovered_capability_when_provider_declares_none() -> None:
    async def run() -> None:
        handler, *_ = _supervisor(provider=_Provider(declare=False))
        config = gateway_config()
        before = await handler.dispatch("runtime.start", _params(config))
        assert before["configDigest"] is None
        await handler.dispatch("runtime.discover", {})
        after = await handler.dispatch("runtime.start", _params(config))
        assert after["configDigest"] == server_connection_digest(
            config, CODEX_MODEL_CONNECTION.payload()
        )

    asyncio.run(run())


# -- fence --------------------------------------------------------------------


def test_stale_switch_revision_is_rejected() -> None:
    async def run() -> None:
        handler, supervisor, provider = _supervisor()
        await handler.dispatch(
            "runtime.start", _params(gateway_config("k5"), revision=5, operation_id="op_5")
        )
        running = supervisor.entry(RUNTIME_ID).runtime

        for method in ("runtime.start", "runtime.validateConfig"):
            with pytest.raises(SwitchRevisionStaleError) as raised:
                await handler.dispatch(
                    method, _params(gateway_config("k4"), revision=4, operation_id="op_4")
                )
            assert raised.value.code == "switch_revision_stale"

        # The stale attempt did not touch the running instance.
        entry = supervisor.entry(RUNTIME_ID)
        assert entry.runtime is running
        assert entry.requested_values == gateway_config("k5")
        assert len(provider.created) == 1

        # A newer revision is accepted.
        newer = await handler.dispatch(
            "runtime.start", _params(gateway_config("k6"), revision=6, operation_id="op_6")
        )
        assert newer["configDigest"] == model_connection_digest(
            gateway_config("k6"), CODEX_MODEL_CONNECTION
        )
        record = supervisor.switch_fence.load(RUNTIME_ID)
        assert record is not None
        assert (record.switch_revision, record.operation_id, record.status) == (6, "op_6", "running")

    asyncio.run(run())


def test_same_switch_revision_is_idempotent_only_for_the_same_operation() -> None:
    async def run() -> None:
        handler, supervisor, provider = _supervisor()
        params = _params(revision=3, operation_id="op_3")
        first = await handler.dispatch("runtime.start", params)
        retried = await handler.dispatch("runtime.start", params)

        assert retried == first
        assert len(provider.created) == 1
        assert provider.created[0].starts == 1
        # validateConfig at the accepted revision of the same operation passes.
        validated = await handler.dispatch("runtime.validateConfig", params)
        assert validated["valid"] is True

        other = _params(gateway_config("other"), revision=3, operation_id="op_other")
        with pytest.raises(SwitchRevisionStaleError):
            await handler.dispatch("runtime.start", other)
        with pytest.raises(SwitchRevisionStaleError):
            await handler.dispatch("runtime.validateConfig", other)
        assert supervisor.entry(RUNTIME_ID).requested_values == gateway_config()

    asyncio.run(run())


# -- hard replacement -----------------------------------------------------------


def test_switch_replaces_the_instance_even_when_the_config_is_unchanged() -> None:
    async def run() -> None:
        handler, supervisor, provider = _supervisor()
        await handler.dispatch("runtime.start", _params())
        first = provider.created[0]

        switched = await handler.dispatch(
            "runtime.start", _params(revision=1, operation_id="op_1")
        )

        assert switched["status"] == "running"
        assert len(provider.created) == 2
        assert first.stops == 1
        assert supervisor.entry(RUNTIME_ID).runtime is not None
        assert provider.created[1].starts == 1

    asyncio.run(run())


def test_switch_never_applies_a_model_change_in_place() -> None:
    async def run() -> None:
        handler, _, provider = _supervisor()
        await handler.dispatch("runtime.start", _params(revision=1, operation_id="op_1"))
        first = provider.created[0]
        changed = {**gateway_config(), "model": {"modelId": "gpt-5-mini"}}

        await handler.dispatch("runtime.start", _params(changed, revision=2, operation_id="op_2"))

        assert first.model_setting_applied is False
        assert first.stops == 1
        assert provider.created[1].config.values == changed

    asyncio.run(run())


def test_requests_without_a_switch_keep_reusing_the_instance() -> None:
    async def run() -> None:
        handler, _, provider = _supervisor()
        await handler.dispatch("runtime.start", _params())
        await handler.dispatch("runtime.start", _params())
        changed = {**gateway_config(), "model": {"modelId": "gpt-5-mini"}}
        await handler.dispatch("runtime.start", _params(changed))

        assert len(provider.created) == 1
        assert provider.created[0].model_setting_applied is True

    asyncio.run(run())


def test_switch_that_cannot_stop_the_old_instance_fails_without_starting_a_new_one() -> None:
    async def run() -> None:
        handler, supervisor, provider = _supervisor()
        await handler.dispatch("runtime.start", _params())
        first = provider.created[0]

        async def refuse_stop() -> None:
            raise RuntimeError("still running")

        first.stop = refuse_stop  # type: ignore[method-assign]
        with pytest.raises(RuntimeError, match="still running"):
            await handler.dispatch(
                "runtime.start", _params(gateway_config("k2"), revision=1, operation_id="op_1")
            )

        assert len(provider.created) == 1
        assert supervisor.entry(RUNTIME_ID).status == "error"

    asyncio.run(run())


# -- model probe ----------------------------------------------------------------


def test_probe_uses_the_config_the_running_instance_loaded() -> None:
    async def run() -> None:
        handler, _, provider = _supervisor()
        probed: list[tuple[dict[str, Any], ModelConnectionCapability | None]] = []

        async def fake_probe(
            config: RuntimeConfig, capability: ModelConnectionCapability | None
        ) -> ModelProbeResult:
            probed.append((dict(config.values), capability))
            return ModelProbeResult("passed", protocol="openai_responses", model="gpt-5", latency_ms=12)

        provider.probe_model_connection = fake_probe  # type: ignore[method-assign]
        config = gateway_config("k-probe")
        await handler.dispatch("runtime.start", _params(config, revision=1, operation_id="op_1"))

        result = await handler.dispatch(
            "runtime.probeModelConnection", {"runtime": "codex", "runtimeId": RUNTIME_ID}
        )

        assert probed == [(config, CODEX_MODEL_CONNECTION)]
        assert result["probe"] == {
            "state": "passed",
            "protocol": "openai_responses",
            "model": "gpt-5",
            "latencyMs": 12,
            "code": None,
            "message": None,
        }
        assert result["configDigest"] == model_connection_digest(config, CODEX_MODEL_CONNECTION)
        assert result["instanceId"] == CONNECTOR_PROCESS_INSTANCE_ID

    asyncio.run(run())


def test_probe_requires_a_running_instance() -> None:
    async def run() -> None:
        handler, _, provider = _supervisor()
        provider.fail_start = True
        with pytest.raises(RuntimeError):
            await handler.dispatch("runtime.start", _params())
        with pytest.raises(RuntimeUnavailableError):
            await handler.dispatch(
                "runtime.probeModelConnection", {"runtime": "codex", "runtimeId": RUNTIME_ID}
            )
        with pytest.raises(RuntimeInvalidRequestError):
            await handler.dispatch(
                "runtime.probeModelConnection", {"runtime": "codex", "runtimeId": "rti_unknown"}
            )

    asyncio.run(run())


def test_validate_config_does_not_advance_the_fence() -> None:
    async def run() -> None:
        handler, supervisor, _provider = _supervisor()
        await handler.dispatch("runtime.start", _params(revision=2, operation_id="op_2"))
        await handler.dispatch(
            "runtime.validateConfig", _params(revision=9, operation_id="op_9")
        )
        record = supervisor.switch_fence.load(RUNTIME_ID)
        assert record is not None
        assert record.switch_revision == 2
        # Revision 3 is still newer than the accepted 2.
        started = await handler.dispatch(
            "runtime.start", _params(gateway_config("k3"), revision=3, operation_id="op_3")
        )
        assert started["status"] == "running"

    asyncio.run(run())


def test_requests_without_switch_fields_never_touch_the_fence() -> None:
    async def run() -> None:
        handler, supervisor, _provider = _supervisor()
        await handler.dispatch("runtime.start", _params(revision=4, operation_id="op_4"))
        await handler.dispatch("runtime.start", _params(gateway_config("manual")))
        record = supervisor.switch_fence.load(RUNTIME_ID)
        assert record is not None
        assert (record.switch_revision, record.operation_id) == (4, "op_4")
        assert supervisor.entry(RUNTIME_ID).requested_values == gateway_config("manual")

    asyncio.run(run())


def test_failed_start_still_consumes_the_switch_revision() -> None:
    async def run() -> None:
        handler, supervisor, provider = _supervisor()
        provider.fail_start = True
        with pytest.raises(RuntimeError, match="start boom"):
            await handler.dispatch("runtime.start", _params(revision=7, operation_id="op_7"))
        record = supervisor.switch_fence.load(RUNTIME_ID)
        assert record is not None
        assert (record.switch_revision, record.status) == (7, "error")
        assert record.config_digest == model_connection_digest(
            gateway_config(), CODEX_MODEL_CONNECTION
        )

        provider.fail_start = False
        with pytest.raises(SwitchRevisionStaleError):
            await handler.dispatch(
                "runtime.start", _params(gateway_config("old"), revision=6, operation_id="op_6")
            )

    asyncio.run(run())


def test_fence_survives_a_connector_restart(tmp_path: Path) -> None:
    directory = tmp_path / "runtime-switch" / "conn_switch"

    async def first_process() -> None:
        handler, *_ = _supervisor(directory)
        await handler.dispatch("runtime.start", _params(revision=8, operation_id="op_8"))

    async def second_process() -> None:
        handler, supervisor, provider = _supervisor(directory)
        with pytest.raises(SwitchRevisionStaleError):
            await handler.dispatch(
                "runtime.start", _params(gateway_config("old"), revision=5, operation_id="op_5")
            )
        with pytest.raises(SwitchRevisionStaleError):
            await handler.dispatch(
                "runtime.validateConfig",
                _params(gateway_config("old"), revision=8, operation_id="op_other"),
            )
        assert provider.created == []
        assert supervisor.entry(RUNTIME_ID).runtime is None
        # The interrupted operation can be retried after the restart.
        retried = await handler.dispatch(
            "runtime.start", _params(revision=8, operation_id="op_8")
        )
        assert retried["status"] == "running"

    asyncio.run(first_process())
    path = directory / f"{RUNTIME_ID}.json"
    saved = json.loads(path.read_text(encoding="utf-8"))
    assert saved["switchRevision"] == 8
    assert saved["operationId"] == "op_8"
    assert saved["status"] == "running"
    assert saved["configDigest"] == model_connection_digest(
        gateway_config(), CODEX_MODEL_CONNECTION
    )
    assert "sk-test-1" not in path.read_text(encoding="utf-8")
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert list(directory.glob("*.tmp")) == []

    asyncio.run(second_process())


def test_unreadable_fence_record_does_not_block_switches(tmp_path: Path) -> None:
    (tmp_path / f"{RUNTIME_ID}.json").write_text("{not json", encoding="utf-8")
    store = RuntimeSwitchFenceStore(tmp_path)
    store.check(RUNTIME_ID, RuntimeSwitchRequest("op_1", 1))


def test_unusual_runtime_ids_are_stored_under_hashed_names(tmp_path: Path) -> None:
    store = RuntimeSwitchFenceStore(tmp_path)
    store.accept("../escape", RuntimeSwitchRequest("op", 1), config_digest=None, status="running")
    files = list(tmp_path.iterdir())
    assert len(files) == 1
    assert files[0].name.startswith("h_")
    assert RuntimeSwitchFenceStore(tmp_path).load("../escape") is not None


# -- transport ----------------------------------------------------------------


def test_stale_revision_reaches_the_server_as_rpc_error_code() -> None:
    async def run() -> None:
        handler, *_ = _supervisor()
        await handler.dispatch("runtime.start", _params(revision=2, operation_id="op_2"))
        channel = ConnectorRpcChannel()
        responses: list[dict[str, Any]] = []

        async def capture(request_id: str, **payload: Any) -> None:
            responses.append({"id": request_id, **payload})

        channel.send_response = capture  # type: ignore[method-assign]
        await channel.handle_message(
            {
                "type": "request",
                "id": "req_1",
                "method": "runtime.start",
                "params": _params(revision=1, operation_id="op_1"),
            },
            handler.dispatch,
        )
        assert isinstance(SwitchRevisionStaleError("x"), RuntimeProtocolError)
        assert responses == [
            {
                "id": "req_1",
                "ok": False,
                "error": {"code": "switch_revision_stale", "message": responses[0]["error"]["message"]},
            }
        ]
        assert "older than the accepted switchRevision 2" in responses[0]["error"]["message"]

    asyncio.run(run())


class _FakeWebSocket:
    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []

    async def send(self, payload: str) -> None:
        self.messages.append(json.loads(payload))


def test_backend_client_persists_fence_and_reports_digest_in_status(tmp_path: Path) -> None:
    config = ConnectorConfig(
        server_url="http://127.0.0.1:8000",
        connector_id="conn_switch",
        connector_token="token",
        sync_existing_on_connect=False,
        state_path=str(tmp_path / "connector-state.json"),
    )
    assert runtime_switch_directory(config) == tmp_path / "runtime-switch" / "conn_switch"

    async def run() -> None:
        client = BackendRpcClient(config, agent_runtime_providers=(_Provider(),))
        websocket = _FakeWebSocket()
        client._rpc.set_connection(websocket)  # type: ignore[arg-type]
        started = await client.dispatch(
            "runtime.start", _params(revision=1, operation_id="op_1")
        )
        digest = model_connection_digest(gateway_config(), CODEX_MODEL_CONNECTION)
        assert started["configDigest"] == digest
        statuses = [
            message["params"]
            for message in websocket.messages
            if message.get("method") == "runtime.statusChanged"
        ]
        assert statuses[-1]["status"] == "running"
        assert statuses[-1]["configDigest"] == digest
        # Not reported while nothing is loaded yet.
        assert all("configDigest" not in status for status in statuses[:-1])

    asyncio.run(run())
    assert (tmp_path / "runtime-switch" / "conn_switch" / f"{RUNTIME_ID}.json").is_file()
