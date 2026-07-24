from __future__ import annotations

from types import SimpleNamespace

from agent_server.services.session_run import _acp_auth_blocked_detail


def test_acp_auth_blocked_detail_returns_hint_for_required_acp_runtime() -> None:
    connector = SimpleNamespace(
        runtimeCapabilities=SimpleNamespace(
            attached={
                "grok_build": SimpleNamespace(
                    report={
                        "authStatus": "required",
                        "authHint": "Set XAI_API_KEY or run grok login",
                    }
                )
            }
        )
    )
    assert (
        _acp_auth_blocked_detail(connector, "grok_build")
        == "Set XAI_API_KEY or run grok login"
    )


def test_acp_auth_blocked_detail_skips_non_acp_and_ok_status() -> None:
    connector = SimpleNamespace(
        runtimeCapabilities=SimpleNamespace(
            attached={
                "claude": SimpleNamespace(report={"authStatus": "required", "authHint": "nope"}),
                "cursor": SimpleNamespace(report={"authStatus": "ok"}),
            }
        )
    )
    assert _acp_auth_blocked_detail(connector, "claude") is None
    assert _acp_auth_blocked_detail(connector, "codex") is None
    assert _acp_auth_blocked_detail(connector, "cursor") is None
    assert _acp_auth_blocked_detail(connector, "missing") is None
