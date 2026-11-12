from __future__ import annotations

import asyncio
import sys

import pytest

from agent_server.core.process_settings import ProcessSettings
from agent_server.infra import malloc_trim
from agent_server.infra.malloc_trim import load_malloc_trim, run_malloc_trim_loop

ENV = "AGENT_SERVER_MALLOC_TRIM_INTERVAL_SECONDS"


def test_malloc_trim_is_disabled_by_default(monkeypatch):
    monkeypatch.delenv(ENV, raising=False)
    assert ProcessSettings.from_environment().malloc_trim_interval_seconds == 0


@pytest.mark.parametrize("value,expected", [("0", 0.0), ("", 0.0), ("30", 30.0), ("300.5", 300.5)])
def test_malloc_trim_interval_is_parsed(monkeypatch, value, expected):
    monkeypatch.setenv(ENV, value)
    assert ProcessSettings.from_environment().malloc_trim_interval_seconds == expected


@pytest.mark.parametrize("value", ["-1", "5", "29.9", "nan", "inf"])
def test_malloc_trim_interval_rejects_unsafe_values(monkeypatch, value):
    monkeypatch.setenv(ENV, value)
    with pytest.raises(ValueError, match=ENV):
        ProcessSettings.from_environment()


class _StopLoop(Exception):
    pass


def _counting_sleep(rounds: int):
    calls: list[float] = []

    async def sleep(seconds: float) -> None:
        calls.append(seconds)
        if len(calls) > rounds:
            raise _StopLoop

    return sleep, calls


def test_loop_trims_once_per_interval():
    sleep, sleeps = _counting_sleep(3)
    trims: list[int] = []

    def trim() -> int:
        trims.append(1)
        return 1

    with pytest.raises(_StopLoop):
        asyncio.run(run_malloc_trim_loop(60, trim=trim, sleep=sleep, rss=lambda: 2**20))
    assert sleeps == [60, 60, 60, 60]
    assert len(trims) == 3


def test_failed_trim_does_not_stop_the_loop():
    sleep, _ = _counting_sleep(2)
    attempts: list[int] = []

    def trim() -> int:
        attempts.append(1)
        raise OSError("boom")

    with pytest.raises(_StopLoop):
        asyncio.run(run_malloc_trim_loop(60, trim=trim, sleep=sleep, rss=lambda: None))
    assert len(attempts) == 2


def test_loop_exits_quietly_without_malloc_trim(monkeypatch):
    monkeypatch.setattr(malloc_trim, "load_malloc_trim", lambda: None)

    async def never_sleep(_seconds: float) -> None:
        pytest.fail("the loop must not run without malloc_trim")

    asyncio.run(run_malloc_trim_loop(60, sleep=never_sleep))


def test_malloc_trim_is_unavailable_outside_linux(monkeypatch):
    monkeypatch.setattr(malloc_trim.sys, "platform", "darwin")
    assert load_malloc_trim() is None


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="glibc only")
def test_malloc_trim_runs_on_glibc():
    trim = load_malloc_trim()
    if trim is None:
        pytest.skip("libc without malloc_trim (for example musl)")
    assert trim() in (0, 1)


@pytest.mark.parametrize("interval", ["0", "45"])
def test_lifespan_runs_the_loop_only_when_enabled(monkeypatch, interval):
    from fastapi.testclient import TestClient

    from agent_server import app as app_module

    monkeypatch.setenv(ENV, interval)
    started: list[float] = []
    cancelled: list[bool] = []

    async def fake_loop(seconds: float) -> None:
        started.append(seconds)
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    monkeypatch.setattr(app_module, "run_malloc_trim_loop", fake_loop)
    with TestClient(app_module.create_app()):
        pass
    if interval == "0":
        assert started == []
    else:
        assert started == [45.0]
        assert cancelled == [True]
