from __future__ import annotations

import claude_agent_sdk

from connector.runtimes.claude.domain.session import ClaudeSession
from connector.runtimes.claude.sdk.client import build_sdk_options


def test_claude_sdk_buffer_handles_25_mib_image_read_result() -> None:
    options = build_sdk_options(
        claude_agent_sdk,
        {},
        ClaudeSession(session_id="sess_buffer"),
    )

    attachment_bytes = 25 * 1024 * 1024
    base64_bytes = 4 * ((attachment_bytes + 2) // 3)
    duplicated_read_result_bytes = 2 * base64_bytes
    json_overhead_bytes = 1024 * 1024

    assert options.max_buffer_size >= (
        duplicated_read_result_bytes + json_overhead_bytes
    )
