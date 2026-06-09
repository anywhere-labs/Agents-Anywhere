from __future__ import annotations

import builtins

import pytest

from agent_server.infra.runtimes.claude.sdk_driver import ClaudeSdkChatDriver, ClaudeSdkUnavailableError


async def _permission_handler(*_args, **_kwargs):
    return None


def test_claude_sdk_driver_builds_agent_options_kwargs():
    driver = ClaudeSdkChatDriver(permission_handler=_permission_handler)

    kwargs = driver.build_options_kwargs(
        {
            "sessionId": "sess_1",
            "externalSessionId": "claude_uuid",
            "cwd": "/repo",
            "claudeCliPath": "/opt/homebrew/bin/claude",
            "permissionMode": "acceptEdits",
            "model": "claude-sonnet-4-6",
            "effort": "high",
        }
    )

    assert kwargs == {
        "include_partial_messages": True,
        "cwd": "/repo",
        "resume": "claude_uuid",
        "cli_path": "/opt/homebrew/bin/claude",
        "permission_mode": "acceptEdits",
        "model": "claude-sonnet-4-6",
        "effort": "high",
        "can_use_tool": _permission_handler,
    }


def test_claude_sdk_driver_raises_clear_error_when_dependency_missing(monkeypatch):
    driver = ClaudeSdkChatDriver()
    original_import = builtins.__import__

    def fake_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "claude_agent_sdk":
            raise ModuleNotFoundError(name)
        return original_import(name, globals, locals, fromlist, level)

    monkeypatch.setattr(builtins, "__import__", fake_import)

    with pytest.raises(ClaudeSdkUnavailableError) as exc:
        driver._load_sdk()

    assert "claude-agent-sdk is not installed" in str(exc.value)


@pytest.mark.anyio
async def test_claude_sdk_driver_start_turn_and_interrupt_with_fake_sdk():
    class FakeOptions:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class FakeClient:
        def __init__(self, *, options):
            self.options = options
            self.connected = False
            self.queries: list[str] = []
            self.interrupted = False

        async def connect(self):
            self.connected = True

        async def query(self, prompt):
            self.queries.append(prompt)

        async def interrupt(self):
            self.interrupted = True

    class FakeSdk:
        ClaudeAgentOptions = FakeOptions
        ClaudeSDKClient = FakeClient

    driver = ClaudeSdkChatDriver(sdk_module=FakeSdk)

    await driver.create_session({"sessionId": "sess_1", "cwd": "/repo"})
    result = await driver.start_turn({"sessionId": "sess_1", "content": "Run tests"})
    interrupted = await driver.interrupt({"sessionId": "sess_1"})

    client = driver._clients["sess_1"]
    assert client.connected is True
    assert client.queries == ["Run tests"]
    assert client.options.kwargs["include_partial_messages"] is True
    assert result == {"turnId": None}
    assert interrupted == {"interrupted": True}
    assert client.interrupted is True
