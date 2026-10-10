from __future__ import annotations

import asyncio

import pytest
from test_claude_runtime import (
    _CLI_MODELS,
    SystemMessage,
    _config,
    _default_sdk,
    _DiscoveryClientType,
    _FakeHookMatcher,
    _RecordingHost,
    _runtime,
    _ScheduledClaudeClient,
    _wait_for_disconnection,
    _wait_until,
)

from connector.runtime_protocol import RuntimeConfig, RuntimeInvalidRequestError
from connector.runtimes.claude.domain.models import (
    claude_model_catalog,
    model_selection_from_selection_id,
)
from connector.runtimes.claude.runtime import ClaudeRuntime
from connector.server.protocol import protocol_selection_id


def _model_selection(model_id, effort=None):
    payload = {"model_id": model_id}
    if effort is not None:
        payload["effort_id"] = effort
    return protocol_selection_id("claude", "model", payload)


def _runtime_using_clients(host, clients, discovery, config=None):
    clients = iter(clients)
    sdk = _default_sdk(ClaudeSDKClient=discovery, HookMatcher=_FakeHookMatcher)

    def factory(_sdk, options):
        client = next(clients)
        client.options = options
        return client

    return ClaudeRuntime(
        config=config or _config(), host=host,
        sdk_loader=lambda: sdk, client_factory=factory,
    )


def test_cli_model_survives_connection_reuse_and_idle_recreation() -> None:
    async def run():
        first, second = _ScheduledClaudeClient(), _ScheduledClaudeClient()
        host = _RecordingHost()
        discovery = _DiscoveryClientType(server_info={"models": _CLI_MODELS})
        runtime = _runtime_using_clients(
            host, [first, second], discovery, _config(idle_timeout_seconds=0.04),
        )
        try:
            selection = _model_selection("claude-fable-5-1", "max")
            result = await runtime.start_turn(
                "models", None, "hello", selections={"model": selection},
            )
            assert result.ok
            await asyncio.wait_for(runtime._sessions["models"].active_task, 1)
            assert host.session_turn_ends[-1]["outcome"] == "completed"
            assert first.options.kwargs["model"] == "claude-fable-5-1"
            assert first.options.kwargs["effort"] == "max"
            await runtime.start_turn("models", "native_timer", "again")
            await asyncio.wait_for(runtime._sessions["models"].active_task, 1)
            assert first.queries == ["hello", "again"]
            assert not second.connected
            await asyncio.wait_for(_wait_for_disconnection(first), 1)
            await runtime.start_turn("models", "native_timer", "schedule")
            await asyncio.wait_for(runtime._sessions["models"].active_task, 1)
            assert host.session_turn_ends[-1]["outcome"] == "completed"
            assert second.options.kwargs["model"] == "claude-fable-5-1"
            assert second.options.kwargs["effort"] == "max"
            assert second.options.kwargs["resume"] == "native_timer"
            saved = host.sync_states["claude/scheduled/sessions"]["sessions"]["models"]
            assert saved["taskIds"] == ["timer_1"]
            assert discovery.created == 1
        finally:
            await runtime.stop()

    asyncio.run(run())


@pytest.mark.parametrize("change", ["model", "permission"])
@pytest.mark.parametrize("background", [False, True])
def test_cli_model_selection_refresh_preserves_cron_and_background_ownership(
    change, background,
) -> None:
    async def run():
        first, second = _ScheduledClaudeClient(), _ScheduledClaudeClient()
        host = _RecordingHost()
        discovery = _DiscoveryClientType(server_info={"models": _CLI_MODELS})
        runtime = _runtime_using_clients(host, [first, second], discovery)
        initial = _model_selection("claude-fable-5-1", "max")
        try:
            await runtime.start_turn("timer", None, "schedule", selections={"model": initial})
            await asyncio.wait_for(runtime._sessions["timer"].active_task, 1)
            assert host.session_turn_ends[-1]["outcome"] == "completed"
            connection = runtime._turns.runner.connections["timer"]
            if background:
                await first.incoming.put(SystemMessage(
                    subtype="task_started", task_id="bg_1", data={"task_id": "bg_1"},
                ))
                await _wait_until(lambda: bool(connection.background.active_ids))
            if change == "model":
                updated = {"model": _model_selection("opus[1m]", "high")}
            else:
                permission = (await runtime.list_permission_catalog(query="plan")).permissions[0]
                updated = {"permission": permission.selection_id}
            result = await runtime.update_session_selections("timer", "native_timer", updated)
            assert result.ok
            if background:
                assert not first.disconnected
                assert not second.connected
                await first.incoming.put(SystemMessage(
                    subtype="task_updated", task_id="bg_1",
                    patch={"status": "completed"}, data={"task_id": "bg_1"},
                ))
                await _wait_until(lambda: not connection.background.active_ids)
            else:
                assert first.disconnected
                assert second.connected
                assert second.queries == []
            await runtime.start_turn("timer", "native_timer", "hello")
            await asyncio.wait_for(runtime._sessions["timer"].active_task, 1)
            assert host.session_turn_ends[-1]["outcome"] == "completed"
            assert first.disconnected
            assert second.options.kwargs["resume"] == "native_timer"
            if change == "model":
                assert second.options.kwargs["model"] == "opus[1m]"
                assert second.options.kwargs["effort"] == "high"
            else:
                assert second.options.kwargs["model"] == "claude-fable-5-1"
                assert second.options.kwargs["effort"] == "max"
                assert second.options.kwargs["permission_mode"] == "plan"
            saved = host.sync_states["claude/scheduled/sessions"]["sessions"]["timer"]
            assert saved["taskIds"] == ["timer_1"]
            assert saved["selections"] == {"model": initial, **updated}
            assert discovery.created == 1
        finally:
            await runtime.stop()

    asyncio.run(run())


@pytest.mark.parametrize(
    ("model_id", "effort", "expected_model", "discoveries"),
    [
        ("claude-fable-5-1", "max", "claude-fable-5-1", 1),
        ("default", "max", None, 1),
        ("claude-opus-4-8", "high", "claude-opus-4-8", 0),
        ("local-cron", None, "local-cron", 0),
    ],
)
def test_saved_cron_resolves_models_before_connecting_without_catalog_read(
    model_id, effort, expected_model, discoveries,
) -> None:
    async def run():
        selection = _model_selection(model_id, effort)
        host = _RecordingHost()
        host.sync_states["claude/scheduled/sessions"] = {
            "sessions": {
                "timer": {
                    "externalSessionId": "native_timer", "cwd": "/project",
                    "selections": {"model": selection}, "taskIds": ["timer_1"],
                },
            },
        }
        client = _ScheduledClaudeClient()
        discovery = _DiscoveryClientType(server_info={"models": _CLI_MODELS})
        runtime = _runtime_using_clients(
            host, [client], discovery,
            RuntimeConfig(runtime="claude", revision=1, values={
                "environment": {}, "customModels": [{"modelId": "local-cron", "displayName": "Local Cron"}],
            }),
        )
        try:
            await runtime.start()
            assert client.connected
            assert client.queries == []
            assert client.options.kwargs["resume"] == "native_timer"
            assert client.options.kwargs["cwd"] == "/project"
            if expected_model is None:
                assert "model" not in client.options.kwargs
            else:
                assert client.options.kwargs["model"] == expected_model
            if effort is None:
                assert "effort" not in client.options.kwargs
            else:
                assert client.options.kwargs["effort"] == effort
            assert runtime._turns.runner.connections["timer"].task_ids == {"timer_1"}
            assert discovery.created == discoveries
            await client.reply("resumed cron reply")
            await _wait_until(lambda: len(host.session_turn_ends) == 1)
            assert host.session_turn_ends[-1]["outcome"] == "completed"
            saved = host.sync_states["claude/scheduled/sessions"]["sessions"]["timer"]
            assert saved["selections"] == {"model": selection}
        finally:
            await runtime.stop()

    asyncio.run(run())


@pytest.mark.parametrize(
    ("capabilities", "visible_efforts"),
    [
        ({}, ()),
        ({"supportsEffort": True, "supportedEffortLevels": ["low"]}, ("low",)),
    ],
)
def test_saved_static_effort_survives_overlapping_cli_model(
    capabilities, visible_efforts,
) -> None:
    async def run():
        selection = _model_selection("claude-opus-4-8", "high")
        host = _RecordingHost()
        host.sync_states["claude/scheduled/sessions"] = {
            "sessions": {"timer": {
                "externalSessionId": "native_timer", "cwd": "/project",
                "selections": {"model": selection}, "taskIds": ["timer_1"],
            }},
        }
        cli_models = [
            {"value": "claude-opus-4-8", "displayName": "CLI Opus", **capabilities},
            {"value": "new-cli-only"},
        ]
        discovery = _DiscoveryClientType(server_info={"models": cli_models})
        client = _ScheduledClaudeClient()
        runtime = _runtime_using_clients(host, [client], discovery)
        try:
            catalog = await runtime.list_model_catalog()
            model = next(item for item in catalog.models if item.id == "claude-opus-4-8")
            assert model.title == "CLI Opus"
            assert model.metadata["source"] == "claude-code.initialize"
            assert tuple(item.id for item in model.reasoning_items) == visible_efforts

            resolved = model_selection_from_selection_id(selection, cli_models=cli_models)
            assert resolved.model_id == "claude-opus-4-8"
            assert resolved.effort_id == "high"
            await runtime.start()
            assert client.connected
            assert client.queries == []
            assert client.options.kwargs["resume"] == "native_timer"
            assert client.options.kwargs["model"] == "claude-opus-4-8"
            assert client.options.kwargs["effort"] == "high"
            assert runtime._turns.runner.connections["timer"].task_ids == {"timer_1"}

            with pytest.raises(RuntimeInvalidRequestError, match="unknown Claude model selection"):
                model_selection_from_selection_id(
                    _model_selection("new-cli-only", "high"), cli_models=cli_models,
                )
            assert discovery.created == 1
        finally:
            await runtime.stop()

    asyncio.run(run())


@pytest.mark.parametrize("initial_failure", [False, True])
def test_unknown_cli_selection_refreshes_after_discovery_ttl(initial_failure) -> None:
    async def run():
        discovery = _DiscoveryClientType(
            server_info={"models": _CLI_MODELS},
            connect_error=RuntimeError("discovery unavailable") if initial_failure else None,
        )
        client = _ScheduledClaudeClient()
        host = _RecordingHost()
        runtime = _runtime(
            client=client, host=host,
            sdk=_default_sdk(ClaudeSDKClient=discovery, HookMatcher=_FakeHookMatcher),
        )
        clock = [0.0]
        runtime._catalogs.discovery.clock = lambda: clock[0]
        try:
            await runtime.list_model_catalog()
            selection = _model_selection("claude-new-entitlement")
            rejected = await runtime.start_turn("new", None, "hello", selections={"model": selection})
            assert not rejected.ok
            assert discovery.created == 1
            discovery.connect_error = None
            discovery.server_info = {"models": [*_CLI_MODELS, {"value": "claude-new-entitlement"}]}
            clock[0] = 61.0 if initial_failure else 601.0
            accepted = await runtime.start_turn("new", None, "hello", selections={"model": selection})
            assert accepted.ok
            await asyncio.wait_for(runtime._sessions["new"].active_task, 1)
            assert host.session_turn_ends[-1]["outcome"] == "completed"
            assert client.options.kwargs["model"] == "claude-new-entitlement"
            assert discovery.created == 2
            assert all(instance.queries == [] for instance in discovery.instances)
        finally:
            await runtime.stop()

    asyncio.run(run())


def test_cli_model_titles_show_version_and_context_like_claude_code() -> None:
    # Shapes Claude Code 2.1 reports at initialize: aliases are labelled by family only.
    cli_models = [
        {"value": "default", "displayName": "Default (recommended)", "resolvedModel": "claude-opus-5-5",
         "description": "Use the default model (currently Opus 5.5) · $4/$20 per Mtok"},
        {"value": "opus[1m]", "displayName": "Opus (1M context)", "resolvedModel": "claude-opus-5-5[1m]",
         "description": "Opus 5.5 for long sessions · $4/$20 per Mtok"},
        {"value": "fable", "displayName": "Fable", "resolvedModel": "claude-fable-5-1",
         "description": "Fable 5.1 · Most capable for your hardest and longest-running tasks"},
        {"value": "claude-sonnet-5[1m]", "displayName": "Sonnet 5", "resolvedModel": "claude-sonnet-5[1m]",
         "description": "Newer version available · select Sonnet for Sonnet 5.5"},
        {"value": "haiku", "displayName": "Haiku", "resolvedModel": "claude-haiku-4-5-20251001"},
        {"value": "sonnet", "displayName": "Sonnet", "description": "Sonnet 5.5 · Efficient for routine tasks"},
        # A gateway model whose description happens to name a Claude version stays unlabelled.
        {"value": "opus", "displayName": "Opus", "resolvedModel": "deepseek-v4",
         "description": "Opus 5.5 · routed through the team gateway"},
        {"value": "claude-next", "displayName": "Next", "description": "Newer version available · select Sonnet for Sonnet 5.5"},
        {"value": "local-model"},
        # Bedrock and Vertex ids, current and version-first naming.
        {"value": "bedrock-opus", "displayName": "Opus", "resolvedModel": "us.anthropic.claude-opus-4-1-20250805-v1:0"},
        {"value": "bedrock-sonnet", "displayName": "Sonnet", "resolvedModel": "global.anthropic.claude-sonnet-4-5-20250929-v1:0"},
        {"value": "vertex-opus", "displayName": "Opus", "resolvedModel": "claude-opus-4-1@20250805"},
        {"value": "vertex-opus-4", "displayName": "Opus", "resolvedModel": "claude-opus-4@20250514"},
        {"value": "legacy-sonnet", "displayName": "Sonnet", "resolvedModel": "claude-3-5-sonnet-20241022"},
        {"value": "bedrock-haiku", "displayName": "Haiku", "resolvedModel": "anthropic.claude-3-haiku-20240307-v1:0"},
    ]

    models = claude_model_catalog(revision=1, cli_models=cli_models).models

    assert [model.title for model in models] == [
        "Default (Opus 5.5)",
        "Opus 5.5 (1M context)",
        "Fable 5.1",
        "Sonnet 5 (1M context)",
        "Haiku 4.5",
        "Sonnet 5.5",
        "Opus",
        "Next",
        "local-model",
        "Opus 4.1",
        "Sonnet 4.5",
        "Opus 4.1",
        "Opus 4",
        "Sonnet 3.5",
        "Haiku 3",
    ]
    assert models[1].metadata["cliDisplayName"] == "Opus (1M context)"
    assert models[1].description == "Opus 5.5 for long sessions · $4/$20 per Mtok"
    assert "cliDisplayName" not in models[6].metadata
    # Titles are display only: selections still carry Claude Code's model values.
    assert model_selection_from_selection_id(models[1].selection_id, cli_models=cli_models).model_id == "opus[1m]"
