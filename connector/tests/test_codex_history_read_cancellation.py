import asyncio
from dataclasses import replace

import pytest
from test_codex_runtime import FakeCodexClient, FakeHost, _config

from connector.runtime_protocol import SessionNotice
from connector.runtimes.codex.runtime import CodexRuntime


@pytest.mark.parametrize("publication", ["session_state_update", "notice_upsert", "session_turn_ended"])
def test_cancelled_history_reader_preserves_terminal_publication(publication):
    async def exercise():
        host = FakeHost()
        runtime = CodexRuntime(config=_config(), host=host, client=FakeCodexClient())
        handler = runtime._notifications.turn_lifecycle
        expected = await runtime._session_states.update(
            "sess_1", "thread_1", "running", metadata={"turn_id": "turn_1"},
        )
        handler.active_turn_ids["sess_1"] = "turn_1"
        handler.notice_handler.notices.upsert(SessionNotice(
            notice_id="approval", session_id="sess_1", runtime="codex",
            type="interaction", title="Approval", blocking={"kind": "approval"},
        ))
        terminal = replace(expected, status="idle", metadata={
            "source": "codex.thread_history.state", "turn_id": "turn_1",
            "native_activity_evidence": "terminal", "native_status": "completed",
        })
        started = asyncio.Event()
        release = asyncio.Event()
        original = getattr(host, publication)

        async def blocked_publication(*args, **kwargs):
            started.set()
            await release.wait()
            await original(*args, **kwargs)

        setattr(host, publication, blocked_publication)
        reader = asyncio.create_task(handler.reconcile_history_state(terminal, expected))
        await asyncio.wait_for(started.wait(), 1)
        reader.cancel()
        with pytest.raises(asyncio.CancelledError):
            await reader
        pending = next(iter(handler._history_reads.values()))
        assert not pending.done()
        retry = asyncio.create_task(handler.reconcile_history_state(
            terminal, runtime._session_states.get("sess_1"),
        ))
        await asyncio.sleep(0)
        assert list(handler._history_reads.values()) == [pending]
        release.set()
        state = await asyncio.wait_for(retry, 1)
        assert state.status == "idle"
        assert len(host.turn_ends) == 1
        assert [(notice.notice_id, notice.status) for notice in host.notice_upserts] == [("approval", "closed")]
        assert not handler._history_reads
        await runtime.stop()

    asyncio.run(exercise())


def test_runtime_stop_cleans_up_detached_history_reader():
    async def exercise():
        runtime = CodexRuntime(config=_config(), host=FakeHost(), client=FakeCodexClient())
        handler = runtime._notifications.turn_lifecycle
        state = await runtime._session_states.update("sess_1", "thread_1", "idle")
        lock = handler.session_lock("sess_1")
        await lock.acquire()
        reader = asyncio.create_task(handler.reconcile_history_state(state, state))
        await asyncio.sleep(0)
        reader.cancel()
        with pytest.raises(asyncio.CancelledError):
            await reader
        pending = next(iter(handler._history_reads.values()))
        await asyncio.wait_for(runtime.stop(), 1)
        assert pending.cancelled()
        assert not handler._history_reads
        lock.release()

    asyncio.run(exercise())
