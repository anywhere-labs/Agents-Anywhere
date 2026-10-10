from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

from connector.runtime_protocol import RuntimeConfig
from connector.runtimes.dsh.runtime import DshRuntime


def test_dsh_new_session_defaults_to_standard_agent_preset():
    async def exercise():
        runtime = DshRuntime(RuntimeConfig("dsh", 1, {}), SimpleNamespace())
        runtime._send_text = AsyncMock()  # type: ignore[method-assign]
        await runtime.create_and_start_session(
            "session", "hello", cwd="D:\\Codex", client_message_id="message"
        )
        assert runtime._send_text.await_args.kwargs["agent_preset"] == "standard"

    asyncio.run(exercise())
