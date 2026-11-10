from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest

from connector.runtime_protocol import (
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeModelItem,
    RuntimeReasoningItem,
    RuntimeSupervisor,
)
from connector.runtime_protocol.catalogs import model_catalog_payload
from connector.runtimes.acp.profiles.pi.settings import update_default_model
from connector.runtimes.codex.sdk.client import CodexSdkClient
from connector.runtimes.codex.sdk.runtime_client import CodexResumeThreadRequest
from connector.runtimes.model_gateway import ModelGateway
from connector.runtimes.runtime_model import (
    RuntimeModelSetting,
    configured_selection_id,
    mark_runtime_model,
    runtime_model_from_config,
    selections_with_runtime_model,
)
from tests.test_runtime_protocol_supervisor import FakeHost, FakeProvider, FakeRuntime

GATEWAY = {"baseUrl": "https://gateway.example/v1", "apiKey": "sk-test"}


def _catalog() -> RuntimeModelCatalog:
    return RuntimeModelCatalog(
        runtime="codex",
        revision=1,
        models=(
            RuntimeModelItem(id="plain", title="Plain", selection_id="sel_plain"),
            RuntimeModelItem(
                id="thinker",
                title="Thinker",
                reasoning_items=(
                    RuntimeReasoningItem(id="low", title="Low", selection_id="sel_low"),
                    RuntimeReasoningItem(id="high", title="High", selection_id="sel_high"),
                ),
                metadata={"raw": {"defaultReasoningEffort": "high"}},
            ),
        ),
    )


def test_model_setting_with_a_connection_names_an_imported_model() -> None:
    values = {
        "modelGateway": GATEWAY,
        "customModels": [{"modelId": "a", "displayName": "A", "efforts": [{"effortId": "low", "displayName": "Low"}]}],
    }

    assert runtime_model_from_config(values) is None
    assert runtime_model_from_config({**values, "model": {"modelId": "a", "effortId": "low"}}) == RuntimeModelSetting("a", "low")
    with pytest.raises(RuntimeInvalidRequestError):
        runtime_model_from_config({**values, "model": {"modelId": "b"}})
    with pytest.raises(RuntimeInvalidRequestError):
        runtime_model_from_config({**values, "model": {"modelId": "a", "effortId": "max"}})
    with pytest.raises(RuntimeInvalidRequestError):
        runtime_model_from_config({**values, "model": {"modelId": "a", "provider": "x"}})
    # Without a connection the runtime's own catalog decides; any id is kept.
    assert runtime_model_from_config({"model": {"modelId": "native"}}) == RuntimeModelSetting("native")


def test_catalog_marks_the_configured_model_for_new_sessions() -> None:
    plain = mark_runtime_model(_catalog(), RuntimeModelSetting("plain"))
    assert configured_selection_id(plain) == "sel_plain"
    payload = model_catalog_payload(plain)
    assert [model["default"] for model in payload["models"]] == [True, False]

    # A model only selectable by effort takes the chosen effort, else the recommended one.
    assert configured_selection_id(mark_runtime_model(_catalog(), RuntimeModelSetting("thinker", "low"))) == "sel_low"
    recommended = mark_runtime_model(_catalog(), RuntimeModelSetting("thinker"))
    assert configured_selection_id(recommended) == "sel_high"
    assert [item["default"] for item in model_catalog_payload(recommended)["models"][1]["reasoningItems"]] == [False, True]

    assert configured_selection_id(mark_runtime_model(_catalog(), RuntimeModelSetting("missing"))) is None
    assert configured_selection_id(mark_runtime_model(_catalog(), None)) is None


def test_new_sessions_take_the_setting_and_keep_an_explicit_choice() -> None:
    async def run() -> None:
        marked = mark_runtime_model(_catalog(), RuntimeModelSetting("plain"))

        async def catalog() -> RuntimeModelCatalog:
            return marked

        async def broken() -> RuntimeModelCatalog:
            raise RuntimeError("model/list failed")

        assert await selections_with_runtime_model({"permission": "p"}, catalog) == {"permission": "p", "model": "sel_plain"}
        assert await selections_with_runtime_model({"model": "sel_other"}, catalog) == {"model": "sel_other"}
        # The session still starts, on the runtime's own model.
        assert await selections_with_runtime_model(None, broken) == {}

    asyncio.run(run())


class _HotRuntime(FakeRuntime):
    def __init__(self, runtime: str = "fake", fail_start: bool = False) -> None:
        super().__init__(runtime=runtime, fail_start=fail_start)
        self.applied: list[dict[str, Any]] = []

    async def apply_model_setting(self, config) -> bool:
        self.applied.append(dict(config.values))
        return True


class _HotProvider(FakeProvider):
    async def create_runtime(self, config, host):
        self.created.append(config)
        return _HotRuntime(runtime=config.runtime)


def test_changing_only_the_model_setting_does_not_restart() -> None:
    async def run() -> None:
        provider = _HotProvider()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())

        first = await supervisor.start("fake", {"mode": "auto"})
        same = await supervisor.start("fake", {"mode": "auto", "model": {"modelId": "b"}})

        assert same is first
        assert len(provider.created) == 1
        assert first.native_runtime.applied == [{"mode": "auto", "model": {"modelId": "b"}}]
        assert supervisor.entry("fake").config.values["model"] == {"modelId": "b"}

        restarted = await supervisor.start("fake", {"mode": "sdk", "model": {"modelId": "b"}})
        assert restarted is not first
        assert len(provider.created) == 2

    asyncio.run(run())


def test_a_runtime_without_hot_model_support_restarts() -> None:
    async def run() -> None:
        provider = FakeProvider()
        supervisor = RuntimeSupervisor(providers=(provider,), host=FakeHost())

        first = await supervisor.start("fake", {"mode": "auto"})
        second = await supervisor.start("fake", {"mode": "auto", "model": {"modelId": "b"}})

        assert second is not first
        assert first.native_runtime.stopped is True

    asyncio.run(run())


def test_pi_points_new_sessions_at_the_configured_model(tmp_path) -> None:
    (tmp_path / "models.json").write_text(json.dumps({"providers": {"aa": {"models": [{"id": "a"}, {"id": "b"}]}}}))
    (tmp_path / "settings.json").write_text(json.dumps({"defaultProvider": "aa", "defaultModel": "a", "extensions": ["guard"]}))

    update_default_model(tmp_path, {"model": {"modelId": "b"}})
    assert json.loads((tmp_path / "settings.json").read_text()) == {"defaultProvider": "aa", "defaultModel": "b", "extensions": ["guard"]}

    # A model the gateway no longer offers falls back to the first one.
    update_default_model(tmp_path, {"model": {"modelId": "gone"}})
    assert json.loads((tmp_path / "settings.json").read_text())["defaultModel"] == "a"


class _ResumeClient:
    def __init__(self, persisted: str | None) -> None:
        self.persisted = persisted
        self.reads: list[dict[str, Any]] = []
        self.resumes: list[dict[str, Any]] = []

    async def request(self, method: str, params: dict[str, Any], response_model: Any = None) -> Any:
        assert method == "thread/read"
        self.reads.append(params)
        return SimpleNamespace(thread={"id": params["threadId"], "model": self.persisted})

    async def thread_resume(self, thread_id: str, params: Any) -> Any:
        payload = params.model_dump(by_alias=True, exclude_none=True) if hasattr(params, "model_dump") else dict(params)
        self.resumes.append(payload)
        return SimpleNamespace(thread={"id": thread_id}, collaboration_mode=None, model=payload.get("model"))


def test_codex_resumes_a_gateway_thread_on_the_model_it_last_used() -> None:
    async def run() -> None:
        gateway = ModelGateway(base_url=GATEWAY["baseUrl"], api_key=GATEWAY["apiKey"])
        low = _ResumeClient("model-a")
        await CodexSdkClient(None, model_gateway=gateway)._resume_thread(low, CodexResumeThreadRequest(thread_id="t1"))
        assert low.reads == [{"threadId": "t1", "includeTurns": False}]
        assert low.resumes[0]["model"] == "model-a"

        # An explicit model is never second-guessed; the read only learns the provider.
        low = _ResumeClient("model-a")
        await CodexSdkClient(None, model_gateway=gateway)._resume_thread(low, CodexResumeThreadRequest(thread_id="t1", model="model-b"))
        assert low.resumes[0]["model"] == "model-b"

        # Without a gateway Codex already keeps the thread's model.
        low = _ResumeClient("model-a")
        await CodexSdkClient(None)._resume_thread(low, CodexResumeThreadRequest(thread_id="t1"))
        assert low.reads == [] and "model" not in low.resumes[0]

    asyncio.run(run())
