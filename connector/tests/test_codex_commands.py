"""Exercise commands through the public runtime without a desktop IPC owner."""

import asyncio

import pytest
from test_codex_runtime import FakeCodexClient, FakeHost, _config

from connector.runtime_protocol import RuntimeConflictError
from connector.runtimes.codex.runtime import CodexRuntime


async def runtime_fixture(status="idle", client=None):
    client = client or FakeCodexClient()
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)
    await runtime._session_states.update("sess_1", "thread_1", status=status)
    return runtime, client, host


def run(coro):
    return asyncio.run(coro)


def test_catalog_exposes_compact_and_kill_chatgpt_without_ipc():
    async def check():
        runtime, client, _ = await runtime_fixture()
        catalog = {c.id: c for c in await runtime.list_commands("sess_1", "thread_1")}
        # kill-chatgpt does not need IPC: it frees threads for the native path.
        assert set(catalog) == {"compact", "kill-chatgpt"}
        assert "open-in-codex-app" not in catalog
        assert all(c.enabled for c in catalog.values())
        assert catalog["compact"].metadata["ui"] == {
            "kind": "execute",
            "allowedStatuses": ["idle", "error"],
            "acceptsMultiline": False,
        }
        assert not catalog["compact"].accepts_args
        assert [
            c.id
            for c in await runtime.list_commands(
                "sess_1", "thread_1", "compact-thread", 1
            )
        ] == ["compact"]
        assert await runtime.list_commands("sess_1", "thread_1", "goal") == ()
        cap = next(
            c
            for c in (
                await runtime.get_session_capabilities("sess_1", "thread_1")
            ).capabilities
            if c.capability_id == "session.commands"
        )
        assert cap.supported and cap.available
        assert client.requests == []

    run(check())


@pytest.mark.parametrize(
    "command",
    [
        "status",
        "goal",
        "review",
        "plan",
        "plan-mode",
        "model",
        "reasoning",
        "permission",
        "permissions",
    ],
)
def test_unsupported_commands_are_rejected_without_native_dispatch(command):
    async def check():
        runtime, client, _ = await runtime_fixture()
        result = await runtime.execute_command(
            "sess_1", command, "thread_1", f"/{command}"
        )
        assert not result.ok and result.code == "unknown_command"
        assert client.requests == []

    run(check())


@pytest.mark.parametrize(
    "command,raw,args",
    [
        ("compact", "", ()),
        ("compact", "/review", ()),
        ("compact", "/compact extra", ()),
        ("compact", "/compact\nextra", ()),
        ("compact", "/compact " + "x" * 4096, ()),
        ("compact", None, (1,)),
        ("compact", None, ("one", "two")),
        ("compact", None, ("extra",)),
        ("compact", None, "text"),
        ("compact!", None, ()),
    ],
)
def test_invalid_command_input_never_reaches_native_client(command, raw, args):
    async def check():
        runtime, client, _ = await runtime_fixture()
        result = await runtime.execute_command("sess_1", command, "thread_1", raw, args)
        assert result.ok is False and result.code == "invalid_command"
        assert client.requests == []

    run(check())


@pytest.mark.parametrize(
    "status", ["running", "waiting", "waiting_approval", "blocked", "unknown"]
)
def test_busy_or_unknown_session_blocks_compact(status):
    async def check():
        runtime, client, _ = await runtime_fixture(status)
        result = await runtime.execute_command("sess_1", "compact", "thread_1")
        assert not result.ok and result.code == "command_unavailable"
        assert result.message == f"session_{status}"
        assert client.requests == []

    run(check())


@pytest.mark.parametrize(
    "availability", ["archived", "deleted", "unavailable", "missing"]
)
def test_unavailable_source_blocks_compact(availability):
    async def check():
        runtime, client, _ = await runtime_fixture()
        await runtime._source_states.update(
            session_id="sess_1",
            external_session_id="thread_1",
            availability=availability,
            reason=None,
            observed_at=None,
            observation_origin="event",
        )
        result = await runtime.execute_command(
            "sess_1", "compact", "thread_1", "/compact"
        )
        assert not result.ok and result.code == "command_unavailable"
        assert result.message == f"session_{availability}"
        assert client.requests == []
        catalog = {c.id: c for c in await runtime.list_commands("sess_1", "thread_1")}
        assert not catalog["compact"].enabled

    run(check())


@pytest.mark.parametrize("command", ["compact", "compact-thread"])
def test_compact_is_accepted_and_never_sent_as_user_text(command):
    async def check():
        runtime, client, _ = await runtime_fixture()
        result = await runtime.execute_command(
            "sess_1", command, "thread_1", f"/{command}"
        )
        assert result.ok and result.result["executionState"] == "accepted"
        assert client.requests[-1] == ("thread/compact/start", {"threadId": "thread_1"})
        assert not any(method == "turn/start" for method, _ in client.requests)

    run(check())


@pytest.mark.parametrize("terminal", ["turn/completed", "turn/failed"])
def test_late_terminal_does_not_hide_a_new_command_turn(terminal):
    async def check():
        runtime, _, host = await runtime_fixture()
        for turn_id in ("ordinary", "compact-followup"):
            await runtime._handle_notification(
                {
                    "method": "turn/started",
                    "params": {"threadId": "thread_1", "turn": {"id": turn_id}},
                }
            )
        await runtime._handle_notification(
            {
                "method": terminal,
                "params": {"threadId": "thread_1", "turn": {"id": "ordinary"}},
            }
        )
        assert runtime._active_turn_ids["sess_1"] == "compact-followup"
        assert runtime._session_states.get("sess_1").status == "running"
        assert host.turn_ends[-1]["turn_id"] == "ordinary"

    run(check())


def test_new_command_turn_remains_running_while_old_completion_is_published():
    async def check():
        runtime, _, host = await runtime_fixture()
        publishing = asyncio.Event()
        release = asyncio.Event()
        original_end = host.session_turn_ended

        async def slow_end(**values):
            publishing.set()
            await release.wait()
            await original_end(**values)

        host.session_turn_ended = slow_end

        def event(method, turn_id):
            return {
                "method": method,
                "params": {"threadId": "thread_1", "turn": {"id": turn_id}},
            }

        await runtime._handle_notification(event("turn/started", "ordinary"))
        completed = asyncio.create_task(
            runtime._handle_notification(event("turn/completed", "ordinary"))
        )
        await publishing.wait()
        started = asyncio.create_task(
            runtime._handle_notification(event("turn/started", "compact-followup"))
        )
        await asyncio.sleep(0)
        release.set()
        await asyncio.gather(completed, started)

        assert runtime._active_turn_ids["sess_1"] == "compact-followup"
        assert runtime._session_states.get("sess_1").status == "running"

    run(check())


@pytest.mark.parametrize(
    "error", [TimeoutError("lost acknowledgement"), ConnectionError("disconnected")]
)
def test_ambiguous_dispatch_never_claims_success_or_retries(error):
    async def check():
        runtime, client, _ = await runtime_fixture()
        client.results["thread/compact/start"] = error
        result = await runtime.execute_command(
            "sess_1", "compact", "thread_1", "/compact"
        )
        assert not result.ok and result.code == "command_outcome_unknown"
        assert result.result == {"executionState": "unknown", "retryable": False}
        assert [
            request for request in client.requests if request[0] != "model/list"
        ] == [("thread/compact/start", {"threadId": "thread_1"})]

    run(check())


def test_other_native_writer_rejects_command_without_prompt_fallback():
    async def check():
        runtime, client, _ = await runtime_fixture()
        client.results["thread/compact/start"] = RuntimeConflictError("active writer")
        result = await runtime.execute_command("sess_1", "compact", "thread_1")
        assert not result.ok and result.code == "command_rejected"
        assert "active writer" in result.message
        assert not any(m == "turn/start" for m, _ in client.requests)

    run(check())
