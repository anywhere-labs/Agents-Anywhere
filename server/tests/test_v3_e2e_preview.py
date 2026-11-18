"""v3 end to end: port preview's control plane with the real Server, Router and TS Connector.

The fake Agent starts a dev server as its own child process (``#serve``) and prints its URL in a tool call; the test
process listens on another port of its own. The device associates ports with sessions from this machine's process
tree and decides ``Commands/previewOpen``; the Server forwards that decision on ``POST /api/v3/previews``.

The device has no frpc here (none on the device's PATH), so a preview the device agrees to ends in
``preview_unavailable`` (the frp data plane), while a port of no session is refused before that with
``preview_port_not_allowed``. Opening through a real frps is covered by connector-ts's opt-in frp test.
"""

from __future__ import annotations

import re
import socket
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from v3_e2e_harness import (
    E2E,
    STARTUP_TIMEOUT,
    SessionSocket,
    create_project,
    e2e_environment,
    enable_fake_agent,
    new_session,
    skip_reason,
    wait_for,
    wait_session,
    wait_text,
)

pytestmark = pytest.mark.skipif(skip_reason() is not None, reason=skip_reason() or "")

PREVIEW_ENV = {"AGENT_SERVER_PREVIEW_DOMAIN": "preview.test", "AGENT_SERVER_PREVIEW_INTERNAL_TOKEN": "t" * 40}


@pytest.fixture(scope="module")
def e2e(request: pytest.FixtureRequest) -> Iterator[E2E]:
    with e2e_environment(request, server_env=PREVIEW_ENV) as env:
        env.wait_status("online", STARTUP_TIMEOUT)
        enable_fake_agent(env)
        create_project(env)
        yield env


def _create_preview(e2e: E2E, port: int, session_id: str) -> httpx.Response:
    return e2e.api.call("POST", f"{e2e.api.base}/api/v3/previews", expect=None, json={
        "deviceId": e2e.connector_id, "port": port, "sessionId": session_id, "visibility": "private",
    })


def _code(response: httpx.Response) -> str:
    detail = response.json().get("detail")
    return str(detail.get("code")) if isinstance(detail, dict) else str(detail)


def _ports(socket_: SessionSocket) -> list[dict[str, Any]]:
    """The latest ``port.listening`` list the session socket received."""
    listening = [event for event in socket_.seen() if event.get("type") == "port.listening"]
    return list((listening[-1].get("payload") or {}).get("ports") or []) if listening else []


def test_only_the_port_a_session_started_passes_port_share(e2e: E2E) -> None:
    session_id = new_session(e2e, "#serve")
    reply = wait_text(e2e, session_id, "serving ")
    port = int(re.search(r"serving (\d+)", " ".join(reply)).group(1))  # type: ignore[union-attr]
    wait_session(e2e, session_id, "idle")

    # The session's capabilities say this device wires preview but has no frp client.
    capabilities = e2e.api.get(f"/sessions/{session_id}/runtime/capabilities")["capabilitySet"]["capabilities"]
    preview = next(c for c in capabilities if c["capabilityId"] == "session.port_preview")
    assert preview["supported"] is True and preview["available"] is False, preview
    assert preview["unavailableReason"] == "preview_unavailable", preview

    # A port of this test process: listening on loopback, but no session started or printed it.
    with socket.socket() as unrelated:
        unrelated.bind(("127.0.0.1", 0))
        unrelated.listen()
        other = unrelated.getsockname()[1]

        events = SessionSocket(e2e.api, session_id)
        try:
            # The device's port list reaches the session with the dev server under this session.
            ports = wait_for(lambda: (found := _ports(events)) and any(p["port"] == port for p in found) and found,
                             30, 0.3, "port.listening with the dev server")
            served = next(p for p in ports if p["port"] == port)
            assert served["sessionId"] == session_id, ports
            assert served["url"] == f"http://localhost:{port}/", ports
            assert all(p["port"] != other for p in ports), ports
        finally:
            events.close()

        allowed = _create_preview(e2e, port, session_id)
        assert allowed.status_code >= 400 and _code(allowed) == "preview_unavailable", allowed.text

        refused = _create_preview(e2e, other, session_id)
        assert refused.status_code >= 400 and _code(refused) == "preview_port_not_allowed", refused.text
