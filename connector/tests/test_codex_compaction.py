"""Compaction must reach the timeline through the real SDK notification router."""

import asyncio
import sys
from contextlib import asynccontextmanager

import openai_codex
import pytest
from openai_codex import AsyncCodex, CodexConfig
from test_codex_runtime import FakeHost, _config
from test_codex_sdk_commands import (
    SERVER,
    Wire,
    assert_no_native_turn_buffers,
    lifecycle,
)

from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.sdk.client import CodexSdkClient
from connector.runtimes.codex.timeline.accumulator import CodexTimelineAccumulator


def compact_item(turn_id, item_id, *, completed=False):
    return {
        "method": "item/completed" if completed else "item/started",
        "params": {
            "threadId": "thread",
            "turnId": turn_id,
            "item": {"id": item_id, "type": "contextCompaction"},
            "startedAtMs": 1,
            "completedAtMs": 2 if completed else None,
        },
    }


@asynccontextmanager
async def fixture(tmp_path):
    wire = Wire(tmp_path)
    server = tmp_path / "app_server.py"
    server.write_text(SERVER)
    sdk = AsyncCodex(
        CodexConfig(
            launch_args_override=(sys.executable, "-u", str(server), str(tmp_path))
        )
    )
    client = CodexSdkClient(sdk, sdk=openai_codex)
    host = FakeHost()
    runtime = CodexRuntime(config=_config(), host=host, client=client)
    await runtime._session_states.update("sess", "thread", status="idle")
    await runtime.start()
    try:
        yield runtime, client, host, wire, sdk
    finally:
        await runtime.stop()


async def wait_until(predicate):
    async with asyncio.timeout(2):
        while not predicate():
            await asyncio.sleep(0.001)


def test_compact_start_is_visible_before_ack_and_updates_in_place_on_completion(
    tmp_path,
):
    async def run():
        async with fixture(tmp_path) as (runtime, _, host, wire, sdk):
            wire.configure(
                before={
                    "thread/compact/start": [
                        lifecycle("compact-turn"),
                        compact_item("compact-turn", "compact-item"),
                    ]
                },
                hold=["thread/compact/start"],
            )
            pending = asyncio.create_task(
                runtime.execute_command("sess", "compact", "thread", "/compact")
            )
            try:
                await wait_until(lambda: host.timeline_item_upserts)
                started = host.timeline_item_upserts[-1]
                assert started.id == "compact-item"
                assert started.status == "running"
                assert started.content["state"] == "started"
                assert host.state_updates[-1]["status"] == "running"
                assert not pending.done()

                wire.configure(release_after={"test/notify": ["thread/compact/start"]})
                await wire.flush(sdk)
                result = await pending
                assert result.ok and result.result["executionState"] == "accepted"
                assert host.timeline_item_upserts[-1].status == "running"

                wire.configure(
                    before={
                        "test/notify": [
                            compact_item(
                                "compact-turn", "compact-item", completed=True
                            ),
                            lifecycle("compact-turn", completed=True),
                        ]
                    }
                )
                await wire.flush(sdk)
                await wait_until(lambda: host.state_updates[-1]["status"] == "idle")
                assert [item.id for item in host.timeline_item_upserts] == [
                    "compact-item",
                    "compact-item",
                ]
                assert host.timeline_item_upserts[-1].content["state"] == "completed"
                assert host.timeline_item_upserts[-1].status == "done"
                snapshot = runtime._timeline.items_from_thread_snapshot(
                    "sess",
                    "thread",
                    {
                        "turns": [
                            {
                                "id": "compact-turn",
                                "items": [
                                    {"id": "compact-item", "type": "contextCompaction"},
                                ],
                            }
                        ]
                    },
                    limit=None,
                )
                assert [item.id for item in snapshot] == ["compact-item"]
                assert wire.calls("thread/compact/start") == [{"threadId": "thread"}]
                assert wire.calls("turn/start") == []
                assert_no_native_turn_buffers(sdk)
            finally:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)

    asyncio.run(run())


@pytest.mark.parametrize(
    "status,expected_status,expected_state",
    [
        ("failed", "failed", "failed"),
        ("interrupted", "failed", "failed"),
        ("completed", "done", "completed"),
    ],
)
def test_compact_terminal_without_item_completion_settles_the_running_marker(
    tmp_path, status, expected_status, expected_state
):
    async def run():
        async with fixture(tmp_path) as (runtime, _, host, wire, sdk):
            wire.configure(
                before={
                    "thread/compact/start": [
                        lifecycle("compact-turn"),
                        compact_item("compact-turn", "compact-item"),
                    ]
                }
            )
            await runtime.execute_command("sess", "compact", "thread", "/compact")
            await wait_until(lambda: host.timeline_item_upserts)
            terminal = lifecycle("compact-turn", completed=True)
            terminal["params"]["turn"].update(
                status=status,
                error={
                    "message": "Compaction failed",
                    "codexErrorInfo": None,
                    "additionalDetails": None,
                }
                if status == "failed"
                else None,
            )
            wire.configure(before={"test/notify": [terminal]})
            await wire.flush(sdk)
            await wait_until(lambda: host.state_updates[-1]["status"] != "running")
            marker = host.timeline_item_upserts[-1]
            assert marker.id == "compact-item"
            assert marker.status == expected_status
            assert marker.content["state"] == expected_state
            if status != "completed":
                assert marker.content["label"] != "对话已压缩"
            assert_no_native_turn_buffers(sdk)

    asyncio.run(run())


def test_repeated_fast_compactions_keep_distinct_native_markers(tmp_path):
    async def run():
        async with fixture(tmp_path) as (runtime, _, host, wire, sdk):
            for index in range(2):
                turn_id, item_id = f"compact-turn-{index}", f"compact-item-{index}"
                wire.configure(
                    before={
                        "thread/compact/start": [
                            lifecycle(turn_id),
                            compact_item(turn_id, item_id),
                            compact_item(turn_id, item_id, completed=True),
                            lifecycle(turn_id, completed=True),
                        ]
                    }
                )
                result = await runtime.execute_command(
                    "sess", "compact", "thread", "/compact"
                )
                assert result.ok
                await wait_until(
                    lambda index=index: (
                        len(host.timeline_item_upserts) == (index + 1) * 2
                    )
                )
                assert host.state_updates[-1]["status"] == "idle"
            assert [(item.id, item.status) for item in host.timeline_item_upserts] == [
                ("compact-item-0", "running"),
                ("compact-item-0", "done"),
                ("compact-item-1", "running"),
                ("compact-item-1", "done"),
            ]
            assert_no_native_turn_buffers(sdk)

    asyncio.run(run())


def test_snapshot_during_compaction_does_not_report_premature_completion():
    timeline = CodexTimelineAccumulator()
    timeline.begin_turn("thread", "compact-turn")
    event = compact_item("compact-turn", "compact-item")
    timeline.item_from_notification("sess", "thread", event["method"], event["params"])
    snapshot = timeline.items_from_thread_snapshot(
        "sess",
        "thread",
        {
            "turns": [
                {
                    "id": "compact-turn",
                    "items": [
                        {"id": "compact-item", "type": "contextCompaction"},
                    ],
                }
            ]
        },
        limit=None,
    )
    assert snapshot[0].status == "running"
    assert snapshot[0].content["state"] == "started"
