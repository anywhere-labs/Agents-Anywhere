"""Recycling a Codex app-server whose credentials were replaced on disk.

Regression: after ``codex login`` switched accounts, the long-lived app-server kept
the previous account cached and failed every turn with "Your access token could not
be refreshed because you have since logged out or signed in to another account.".
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.codex.runtime import CodexRuntime
from connector.runtimes.codex.sdk.client import CodexSdkClient
from test_codex_runtime import FakeCodexClient, FakeHost


class _RestartableFakeCodexClient(FakeCodexClient):
    def __init__(self) -> None:
        super().__init__()
        self.restarts = 0

    async def restart(self) -> None:
        self.restarts += 1


class _FakeAsyncCodex:
    def __init__(self, config: Any = None) -> None:
        self.config = config
        self.started = 0
        self.stopped = 0

    async def start(self, handler: Any = None) -> None:
        _ = handler
        self.started += 1

    async def stop(self) -> None:
        self.stopped += 1


class _FakeCodexSdk:
    AsyncCodex = _FakeAsyncCodex


def _codex_home(tmp_path: Path) -> Path:
    home = tmp_path / "codex-home"
    home.mkdir()
    return home


def _write_auth(path: Path, account_id: str, *, access_token: str = "access") -> None:
    path.write_text(
        json.dumps(
            {
                "auth_mode": "chatgpt",
                "OPENAI_API_KEY": None,
                "tokens": {
                    "account_id": account_id,
                    "access_token": access_token,
                    "refresh_token": f"rt-{account_id}",
                },
            }
        ),
        encoding="utf-8",
    )


def _runtime_config(codex_home: Path) -> RuntimeConfig:
    return RuntimeConfig(
        runtime="codex",
        revision=7,
        values={"environment": {}, "codexHome": str(codex_home)},
    )


def test_runtime_restarts_the_app_server_when_the_account_changes(
    tmp_path: Path,
) -> None:
    asyncio.run(_restart_on_account_change(tmp_path))


async def _restart_on_account_change(tmp_path: Path) -> None:
    codex_home = _codex_home(tmp_path)
    _write_auth(codex_home / "auth.json", "acct_old")
    client = _RestartableFakeCodexClient()
    runtime = CodexRuntime(
        config=_runtime_config(codex_home),
        host=FakeHost(),
        client=client,
    )

    await runtime.start()
    assert client.restarts == 0

    _write_auth(codex_home / "auth.json", "acct_new_and_longer")
    await runtime.start()

    assert client.restarts == 1


def test_runtime_keeps_the_app_server_when_only_tokens_refresh(tmp_path: Path) -> None:
    asyncio.run(_keep_app_server_on_token_refresh(tmp_path))


async def _keep_app_server_on_token_refresh(tmp_path: Path) -> None:
    codex_home = _codex_home(tmp_path)
    auth_file = codex_home / "auth.json"
    _write_auth(auth_file, "acct_same", access_token="access-old")
    client = _RestartableFakeCodexClient()
    runtime = CodexRuntime(
        config=_runtime_config(codex_home),
        host=FakeHost(),
        client=client,
    )

    await runtime.start()
    _write_auth(auth_file, "acct_same", access_token="access-refreshed")
    await runtime.start()

    assert client.restarts == 0


def test_runtime_ignores_unreadable_auth_until_another_account_appears(
    tmp_path: Path,
) -> None:
    asyncio.run(_ignore_unreadable_auth(tmp_path))


async def _ignore_unreadable_auth(tmp_path: Path) -> None:
    codex_home = _codex_home(tmp_path)
    auth_file = codex_home / "auth.json"
    _write_auth(auth_file, "acct_old")
    client = _RestartableFakeCodexClient()
    runtime = CodexRuntime(
        config=_runtime_config(codex_home), host=FakeHost(), client=client
    )

    await runtime.start()
    auth_file.write_text("{", encoding="utf-8")
    await runtime.start()
    auth_file.unlink()
    await runtime.start()
    _write_auth(auth_file, "acct_old")
    await runtime.start()
    assert client.restarts == 0

    _write_auth(auth_file, "acct_new")
    await runtime.start()
    assert client.restarts == 1


def test_concurrent_operations_restart_once_for_one_account_change(
    tmp_path: Path,
) -> None:
    asyncio.run(_concurrent_account_change(tmp_path))


async def _concurrent_account_change(tmp_path: Path) -> None:
    class SlowRestartClient(_RestartableFakeCodexClient):
        def __init__(self) -> None:
            super().__init__()
            self.restarting = asyncio.Event()
            self.resume = asyncio.Event()

        async def restart(self) -> None:
            self.restarts += 1
            self.restarting.set()
            await self.resume.wait()

    codex_home = _codex_home(tmp_path)
    auth_file = codex_home / "auth.json"
    _write_auth(auth_file, "acct_old")
    client = SlowRestartClient()
    runtime = CodexRuntime(
        config=_runtime_config(codex_home), host=FakeHost(), client=client
    )
    await runtime.start()

    _write_auth(auth_file, "acct_new")
    first = asyncio.create_task(runtime.start())
    await client.restarting.wait()
    second = asyncio.create_task(runtime.start())
    await asyncio.sleep(0)
    client.resume.set()
    await asyncio.gather(first, second)

    assert client.restarts == 1


def test_sdk_client_restart_uses_a_new_app_server_and_drops_process_state() -> None:
    asyncio.run(_sdk_client_restart())


async def _sdk_client_restart() -> None:
    async def handler(message: Any) -> None:
        _ = message

    first = _FakeAsyncCodex()
    client = CodexSdkClient(
        first,
        sdk=_FakeCodexSdk,
        config=_runtime_config(Path("/tmp/codex-home")),
    )
    await client.start(handler)
    client._loaded_thread_ids.add("thread_1")

    await client.restart()

    assert first.stopped == 1
    assert client._client is not first
    assert isinstance(client._client, _FakeAsyncCodex)
    assert client._client.started == 1
    assert client._loaded_thread_ids == set()
