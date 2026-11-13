"""Only a complete negotiated replay may replace the persisted AA timeline."""

import asyncio
from dataclasses import asdict, replace
from types import SimpleNamespace

import pytest
from acp import RequestError
from acp.client.connection import ClientSideConnection

from connector.runtimes.acp.application.sessions import SessionService
from connector.runtimes.acp.domain.definitions import (
    AcpError,
    AgentProfile,
    LaunchDefinition,
    Workspace,
)
from connector.runtimes.acp.domain.sessions import SessionBinding
from connector.runtimes.acp.infrastructure.acp.client import AgentClient, Turn
from connector.runtimes.acp.infrastructure.acp.history import HISTORY_RESET
from connector.runtimes.acp.infrastructure.acp.v1 import wire
from connector.runtimes.acp.infrastructure.persistence import Store
from connector.runtimes.acp.infrastructure.projection import Projection


@pytest.fixture
def engine(tmp_path):
    store = Store(tmp_path / "fixture.sqlite")
    app = SessionService(store, AgentProfile("fixture", "Fixture"), LaunchDefinition("unused", (), "fixture"), AgentClient, Projection, tmp_path)
    workspace = Workspace(str(tmp_path), str(tmp_path))
    context = app._new_context("session", workspace)
    generation = context["generation"]
    context.update(sessionId="session", agentSessionId="native", projection=Projection("session", generation, runtime_type="fixture"))
    app.sessions["session"] = context
    binding = SessionBinding("session", "fixture", "fixture", workspace, generation, generation, "native", attachment="attached", foreground="idle")
    store.put("binding", "session", asdict(binding))
    yield app, context, context["client"]
    store.close()


def update(text, kind="agent_message_chunk"):
    return {"sessionUpdate": kind, "content": {"type": "text", "text": text}}


async def reset(agent, phase, revision="revision-1", session_id="native"):
    params = {"sessionId": session_id, "revision": revision, "phase": phase}
    if phase == "begin":
        return await agent.callbacks.ext_method("_" + HISTORY_RESET, params)
    return await agent.callbacks.ext_notification(HISTORY_RESET, params)


def timeline(app):
    return [item for item in app.store.values("projection") if item["sessionId"] == "session"]


def notifications(app):
    return [value for _, _, value in app.store.pending()]


def clear_notifications(app):
    app.store.acknowledge([key for _, key, _ in app.store.pending()])


def test_replay_commits_atomically_without_accepting_current_input(engine):
    app, context, agent = engine

    async def run():
        await agent.receive_update("native", update("old answer"))
        before = timeline(app)
        clear_notifications(app)
        agent.turns["native"] = Turn("unknown-input", "do not echo", [])
        assert await reset(agent, "begin") == {"revision": "revision-1", "ready": True}
        await agent.callbacks.session_update("native", update("surviving user", "user_message_chunk"))
        await agent.callbacks.session_update("native", update("surviving answer"))
        assert timeline(app) == before
        assert notifications(app) == []
        assert not agent.turns["native"].observed
        await reset(agent, "commit")
        assert agent.callbacks.failure is None
        assert not agent.turns["native"].observed
        assert [item["content"]["text"] for item in context["projection"].items.values()] == ["surviving user", "surviving answer"]
        assert not ({item["id"] for item in before} & {item["id"] for item in timeline(app)})
        snapshots = [item for item in notifications(app) if item["method"] == "timeline.sync"]
        assert len(snapshots) == 1 and snapshots[0]["params"]["complete"] is True
        assert len(snapshots[0]["params"]["items"]) == 2
        agent.turns.clear()
        await agent.receive_update("native", update("next answer"))
        assert len(context["projection"].items) == 3
        assert notifications(app)[-1]["method"] == "timeline.itemUpsert"

    asyncio.run(run())


def test_empty_complete_replay_removes_previous_history(engine):
    app, _, agent = engine

    async def run():
        await agent.receive_update("native", update("removed"))
        await reset(agent, "begin")
        await reset(agent, "commit")
        assert timeline(app) == []
        assert next(item for item in notifications(app) if item["method"] == "timeline.sync")["params"]["items"] == []

    asyncio.run(run())


@pytest.mark.parametrize("cause", ["abort", "close", "limit", "invalid_update", "outbox_failure", "outbox_full"])
def test_failed_replay_keeps_old_history_and_requires_recovery(engine, cause, monkeypatch):
    app, context, agent = engine

    async def run():
        await agent.receive_update("native", update("keep this"))
        before = timeline(app)
        original_projection = context["projection"]
        clear_notifications(app)
        await reset(agent, "begin")
        if cause == "limit":
            agent.history.max_bytes = 1
            await agent.callbacks.session_update("native", update("too big"))
        else:
            await agent.callbacks.session_update("native", update("discard this"))
            if cause == "abort":
                await reset(agent, "abort")
            elif cause == "close":
                await agent.close()
            elif cause == "invalid_update":
                await agent.callbacks.session_update("native", {"sessionUpdate": "tool_call"})
                await reset(agent, "commit")
            elif cause == "outbox_full":
                with app.store.transaction():
                    for _ in range(4096):
                        app.store.emit("fixture", {})
                await reset(agent, "commit")
            else:
                original_emit = app._emit

                def fail_snapshot(method, params):
                    if method == "timeline.sync":
                        raise RuntimeError("fixture outbox failure")
                    return original_emit(method, params)

                monkeypatch.setattr(app, "_emit", fail_snapshot)
                await reset(agent, "commit")
        assert timeline(app) == before
        assert context["projection"] is original_projection
        assert context["historyReloadRequired"] is True
        assert app.store.get("history_recovery", "session") is not None
        assert app.store.require("binding", "session")["attachment"] == "recovery_required"
        assert not any(item["method"] == "timeline.sync" for item in notifications(app))
        await agent.receive_update("native", update("lost baseline delta"))
        assert timeline(app) == before
        with pytest.raises(RequestError):
            await reset(agent, "begin", "new-revision")

    asyncio.run(run())


def test_wrong_identity_generation_and_revision_never_replace(engine):
    app, _, agent = engine

    async def run():
        await agent.receive_update("native", update("keep"))
        before = timeline(app)
        with pytest.raises(AcpError, match="绑定"):
            await reset(agent, "begin", session_id="other")
        await reset(agent, "begin")
        with pytest.raises(RequestError):
            await reset(agent, "begin", "nested")
        await reset(agent, "commit", "wrong")
        assert timeline(app) == before
        binding = app._binding(app.store.require("binding", "session"))
        app.store.put("binding", "session", asdict(replace(binding, connection_generation="new-owner")))
        await reset(agent, "commit")
        assert timeline(app) == before
        assert not any(item["method"] == "timeline.sync" for item in notifications(app))
        assert app.store.require("binding", "session")["connection_generation"] == "new-owner"

    asyncio.run(run())


def test_completed_revision_cannot_be_reused(engine):
    _, _, agent = engine

    async def run():
        for revision in ("first", "second"):
            await reset(agent, "begin", revision)
            await reset(agent, "commit", revision)
        with pytest.raises(RequestError):
            await reset(agent, "begin", "first")

    asyncio.run(run())


def test_incomplete_replay_is_marked_for_full_reload_across_process_restart(engine):
    app, _, agent = engine

    async def run():
        await agent.receive_update("native", update("keep after crash"))
        before = timeline(app)
        await reset(agent, "begin")
        await agent.receive_update("native", update("incomplete replay"))
        assert app.store.get("history_recovery", "session") == {"revision": "revision-1"}
        # Startup restoration has no access to the previous process's replay buffer.
        app.restore()
        assert timeline(app) == before
        assert app.store.get("history_recovery", "session") is not None
        assert app.store.require("binding", "session")["attachment"] == "recovery_required"

    asyncio.run(run())


@pytest.mark.parametrize("mismatched_session", [False, True])
def test_recover_failed_replacement_loads_full_history_without_retrying_input(engine, monkeypatch, mismatched_session):
    app, _, agent = engine
    called = []

    async def ignore(*args, **kwargs):
        return None

    def factory(on_update, on_interaction):
        fresh = AgentClient(on_update, on_interaction)

        async def start(*args):
            fresh.initialized({"agentCapabilities": {"loadSession": True, "sessionCapabilities": {"resume": {}}}})
            return {}

        async def load_session(**values):
            called.append(values["session_id"])
            await fresh.callbacks.session_update("native", update("reloaded authoritative history"))
            return {"sessionId": "wrong" if mismatched_session else "native", "configOptions": []}

        fresh.start = start
        fresh.connection = SimpleNamespace(load_session=load_session, close=ignore)
        return fresh

    monkeypatch.setattr(app, "client_factory", factory)
    monkeypatch.setattr(app, "_job", lambda work: work.close())

    async def run():
        await agent.receive_update("native", update("old history"))
        before = timeline(app)
        operation, _ = app.prompts.prepare("session", "unknown-message", "never resend")
        app.prompts.save(operation.lose_connection())
        await reset(agent, "begin")
        await reset(agent, "abort")
        assert app.store.get("history_recovery", "session") is not None
        if mismatched_session:
            with pytest.raises(AcpError, match="不同"):
                await app.recover("session")
            assert timeline(app) == before
            assert app.store.get("history_recovery", "session") is not None
        else:
            result = await app.recover("session")
            assert result["status"] == "idle"
            assert [item["content"]["text"] for item in timeline(app)] == ["reloaded authoritative history"]
            assert app.store.get("history_recovery", "session") is None
            assert app.store.require("binding", "session")["connection_generation"] == app.sessions["session"]["generation"]
        assert called == ["native"]
        assert app.store.values("prompt")[0]["message_accepted"] is None

    asyncio.run(run())


def test_approval_replayed_during_reset_is_not_execution_evidence(engine, monkeypatch):
    _, _, agent = engine

    async def answer(*args):
        return {"action": "cancel"}

    monkeypatch.setattr(agent, "ask", answer)

    async def run():
        agent.turns["native"] = Turn("unknown-message", "never echo", [])
        await reset(agent, "begin")
        assert await agent.request_interaction("native", "permission", {}) == {"action": "cancel"}
        assert agent.turns["native"].observed is False
        await reset(agent, "abort")

    asyncio.run(run())


@pytest.mark.parametrize("enabled", [False, True])
def test_initialize_only_negotiates_when_atomic_consumer_enabled(monkeypatch, enabled):
    sent = []

    async def ignore(*args):
        return None

    async def start(*args):
        return SimpleNamespace(stdin=None, stdout=None)

    async def request_model(connection, method, params, response):
        assert method == "initialize"
        sent.append(wire(params))
        return {"protocolVersion": 1, "agentCapabilities": {}}

    agent = AgentClient(ignore, ignore)
    if enabled:
        agent.enable_history_replacement()
    sdk_connection = ClientSideConnection.__new__(ClientSideConnection)
    sdk_connection._conn = None
    monkeypatch.setattr(agent.process, "start", start)
    monkeypatch.setattr("acp.client.connection.request_model", request_model)
    monkeypatch.setattr("connector.runtimes.acp.infrastructure.acp.client.connect_to_agent", lambda *args, **kwargs: sdk_connection)
    asyncio.run(agent.start(LaunchDefinition("unused", (), "fixture"), "/fixture"))
    assert (sent[0].get("_meta") or {}).get("codexIpc") == ({"historyReplacement": True} if enabled else None)
    if not enabled:
        with pytest.raises(RequestError) as error:
            asyncio.run(reset(agent, "begin"))
        assert error.value.code == -32601
