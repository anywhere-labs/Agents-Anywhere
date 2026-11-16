from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from agent_server.core import device_meshcall as dl
from agent_server.core.e2ee import ClientTunnelFrame, PairingPayload
from agent_server.core.preview import CreatePreviewRequest
from agent_server.core.protocol_v1_2 import ProtocolSessionSnapshotResponseV12

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
DEVICE_MESHCALL_DIR = REPOSITORY_ROOT / "contracts" / "device-meshcall" / "1.0"


def test_v3_contract_artifacts_are_fresh() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "scripts.export_v3_contracts", "--check"],
        cwd=REPOSITORY_ROOT / "server",
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def _mesh_contract() -> dict:
    return json.loads((DEVICE_MESHCALL_DIR / "device.meshcall.json").read_text())


def test_mesh_contract_covers_every_business_method() -> None:
    routes = {
        (s["name"], m["name"]): m["stream"] for s in _mesh_contract()["services"] for m in s["methods"]
    }
    expected = [*dl.REQUEST_METHODS.values(), *dl.LINK_ROUTES.values()]
    expected += [dl.command_route(name) for name in dl.COMMAND_METHODS]
    for route in expected:
        assert routes.get((route.service, route.method)) == route.shape, route
    assert len(routes) == len(expected)


def test_mesh_services_are_targeted_and_versioned() -> None:
    contract = _mesh_contract()
    assert contract["protocol"] == "meshcall/1"
    for service in contract["services"]:
        assert service["targeted"] is True
        assert service["name"].startswith("aa.device.v1.")
        for method in service["methods"]:
            if method["stream"] == "duplex":
                assert method["duplex_reason"]
                assert not method["annotations"]["idempotent"]
                assert not method["annotations"]["read_only"]


def test_command_routes_are_camel_case() -> None:
    assert dl.command_route("session.queue.sendNow").method == "sessionQueueSendNow"
    assert dl.command_route("preview.open").service == "aa.device.v1.Commands"
    names = [dl.command_route(name).method for name in dl.COMMAND_METHODS]
    assert len(set(names)) == len(names)


def test_command_ack_never_carries_unknown() -> None:
    dl.CommandAck(outcome="accepted")
    with pytest.raises(ValidationError):
        dl.CommandAck(outcome="unknown")
    # ``unknown`` is still a valid answer of command.status.
    dl.CommandStatusResponse(commandId="c", known=True, outcome="unknown")


@pytest.mark.parametrize(
    ("code", "reason", "opened", "expected"),
    [
        ("unavailable", "no_instances", True, "not_delivered"),
        ("unavailable", "instance_unknown", True, "not_delivered"),
        ("unavailable", "instance_lost", True, "outcome_unknown"),
        ("deadline_exceeded", None, True, "outcome_unknown"),
        ("unavailable", "instance_lost", False, "not_delivered"),
        ("aa.queue_full", None, True, "application"),
    ],
)
def test_mesh_errors_never_report_unknown_outcomes_as_offline(
    code: str, reason: str | None, opened: bool, expected: str
) -> None:
    assert dl.classify_mesh_error(code, reason, opened=opened) == expected


def test_welcome_carries_scoped_mesh_credentials() -> None:
    welcome = dl.LinkWelcome(
        contractVersion="1.0",
        serverVersion="3.0.0",
        connectionId="conn_2",
        mesh=dl.MeshCredentials(
            routerUrl="wss://aa.example.com/api/v3/device/mesh",
            token="mt_x",
            tokenId="tok_2",
            expiresAt="2026-11-16T00:15:00Z",
            instanceId="dev_1",
            services=["aa.device.v1.Link"],
        ),
    )
    assert welcome.mesh.maxFrameBytes == dl.MESH_MAX_FRAME_BYTES
    with pytest.raises(ValidationError):
        dl.LinkWelcome(contractVersion="1.0", serverVersion="3.0.0", connectionId="c")


def test_seq_ceiling_is_written_once_per_stride() -> None:
    assert dl.next_seq_ceiling(0, 1) == 1 + dl.SEQ_CEILING_STRIDE
    assert dl.next_seq_ceiling(1025, 1000) is None
    assert dl.next_seq_ceiling(1025, 1025) is None
    assert dl.next_seq_ceiling(1025, 1026) == 1026 + dl.SEQ_CEILING_STRIDE


def test_seq_floor_never_goes_below_forwarded_sequences() -> None:
    # head_seq lags behind forwarded changes; the ceiling covers the gap.
    assert dl.seq_floor(head_seq=40, seq_ceiling=1100) == 1100
    assert dl.seq_floor(head_seq=2000, seq_ceiling=1100) == 2000


def test_display_envelope_modes() -> None:
    plain = dl.DisplayEnvelope(mode="plain", payload={"title": "hello"})
    sealed = dl.DisplayEnvelope(mode="sealed", keyId="dk_1", payload="Y2lwaGVy")
    assert plain.payload == {"title": "hello"}
    assert sealed.keyId == "dk_1"


def test_session_summary_carries_no_text_outside_the_envelope() -> None:
    fields = set(dl.SessionSummary.model_fields)
    assert "title" not in fields and "cwd" not in fields
    assert "displayDevice" in fields
    assert set(dl.LatestItemFacts.model_fields) == {"id", "type", "role", "status", "time"}


def test_method_registries_are_disjoint() -> None:
    commands = set(dl.COMMAND_METHODS)
    requests = set(dl.REQUEST_METHODS)
    assert not commands & requests
    assert "session.sendMessage" in commands and "client.snapshot" in requests
    assert "changes" not in dl.EVENT_METHODS  # changes travel on Sessions/watch


def test_client_tunnel_frame_is_closed() -> None:
    frame = {"t": "tun", "route": {"deviceId": "d", "clientId": "c", "ch": "c_1"}, "n": 0, "ct": "AAAA"}
    ClientTunnelFrame.model_validate(frame)
    with pytest.raises(ValidationError):
        ClientTunnelFrame.model_validate({**frame, "extra": 1})


def test_protocol_1_2_snapshot_is_additive() -> None:
    fields = ProtocolSessionSnapshotResponseV12.model_fields
    assert fields["historySource"].default == "live"
    assert fields["deviceOffline"].default is False


def test_pairing_payload_and_preview_request_validate() -> None:
    PairingPayload(
        deviceId="dev_1",
        deviceIdentityPub="AAAA",
        pairingId="pair_1",
        psk="BBBB",
        serverUrl="https://aa.example.com",
        e2eeMode="required",
        expiresAt="2026-11-16T00:10:00Z",
    )
    with pytest.raises(ValidationError):
        CreatePreviewRequest(deviceId="dev_1", port=70000)
