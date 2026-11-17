from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

from agent_server.core import device_meshcall as dl
from agent_server.core import e2ee
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
    assert "session.sync" in commands and "client.call" in requests
    assert "changes" not in dl.EVENT_METHODS  # changes travel on Sessions/watch


def test_client_api_methods_travel_only_over_client_call() -> None:
    """User commands and session reads are client API routes the device serves through ``Client/call``; the
    Server registers only its own commands and reads, while the inbox keeps every command payload."""

    assert set(dl.COMMAND_METHODS) <= set(dl.DEVICE_COMMANDS) == set(dl.COMMAND_PAYLOADS)
    for name in ("session.sendMessage", "session.steer", "session.interrupt", "session.respondNotice",
                 "session.select", "session.planning", "session.goal", "session.queue.sendNow"):
        assert name in dl.COMMAND_PAYLOADS and name not in dl.COMMAND_METHODS
    for name in ("client.snapshot", "session.state", "session.queue", "store.read", "store.changesSince",
                 "store.planDocument", "runtime.catalogs", "workspace.call", "workspace.terminalOutput"):
        assert name not in dl.REQUEST_METHODS
    services = dl.registered_services("off")
    assert "aa.device.v1.Runtime" not in services and "aa.device.v1.Workspace" not in services
    assert "sessionSendMessage" not in services["aa.device.v1.Commands"]


def test_client_tunnel_frame_is_closed() -> None:
    client_id = "cli_" + "a" * 26
    frame = {"t": "tun", "route": {"deviceId": "d", "clientId": client_id, "ch": "c_1"}, "n": 0, "ct": "AAAA"}
    ClientTunnelFrame.model_validate(frame)
    with pytest.raises(ValidationError):
        ClientTunnelFrame.model_validate({**frame, "extra": 1})
    with pytest.raises(ValidationError):
        ClientTunnelFrame.model_validate({**frame, "route": {**frame["route"], "clientId": "c"}})
    with pytest.raises(ValidationError):
        ClientTunnelFrame.model_validate({**frame, "route": {**frame["route"], "ch": "a/b"}})


def test_protocol_1_2_snapshot_is_additive() -> None:
    fields = ProtocolSessionSnapshotResponseV12.model_fields
    assert fields["historySource"].default == "live"
    assert fields["deviceOffline"].default is False


def test_pairing_payload_and_preview_request_validate() -> None:
    PairingPayload(
        deviceId="dev_1",
        deviceIdentityPub="A" * 43,
        pairingId="pair_1",
        psk="B" * 43,
        serverUrl="https://aa.example.com",
        e2eeMode="required",
        expiresAt="2026-11-16T00:10:00Z",
    )
    with pytest.raises(ValidationError):
        CreatePreviewRequest(deviceId="dev_1", port=70000)


E2EE_VECTORS = REPOSITORY_ROOT / "contracts" / "e2ee" / "1.0" / "vectors"


def test_e2ee_helpers_match_the_shared_vectors() -> None:
    """The Python helpers and the independent generator agree byte for byte."""

    formats = json.loads((E2EE_VECTORS / "aa-formats.json").read_text())
    for identity in formats["identities"]:
        pub = bytes.fromhex(identity["identityPub"])
        assert e2ee.client_id_for(pub) == identity["clientId"]
        assert e2ee.is_client_id(identity["clientId"])
        assert e2ee.identity_fingerprint(pub) == identity["fingerprint"]
        assert e2ee.b64url(pub) == identity["identityPubB64"]
    pair, connect = formats["prologues"]
    assert e2ee.pairing_prologue(*pair["fields"]).hex() == pair["bytes"]
    assert e2ee.connect_prologue(*connect["fields"]).hex() == connect["bytes"]
    for envelope in formats["displayEnvelopes"]:
        ad = e2ee.display_envelope_ad(envelope["deviceId"], envelope["sessionId"], envelope["slot"], envelope["keyId"])
        assert ad.hex() == envelope["ad"]
    for sealed in formats["sealedObjects"]:
        for segment in sealed["segments"]:
            ad = e2ee.sealed_segment_ad(sealed["purpose"], sealed["objectId"], segment["index"], segment["final"])
            assert ad.hex() == segment["ad"]
    for digest in formats["inputDigests"]:
        key = bytes.fromhex(digest["directoryKey"])
        assert e2ee.input_digest_key(key).hex() == digest["digestKey"]
        assert e2ee.input_digest(key, digest["body"].encode()) == digest["inputDigest"]
        e2ee.CommandRegistration(commandId="c_1", deviceId="dev", inputDigest=digest["inputDigest"])
    uri = formats["pairingUri"]
    assert uri["uri"].startswith(e2ee.PAIRING_URI_PREFIX)
    decoded = e2ee.b64url_decode(uri["uri"][len(e2ee.PAIRING_URI_PREFIX):])
    assert PairingPayload.model_validate_json(decoded).model_dump() == uri["payload"]


def test_tunnel_end_codes_have_client_messages() -> None:
    from typing import get_args

    messages = json.loads((REPOSITORY_ROOT / "contracts" / "runtime-errors" / "1.1" / "messages.json").read_text())
    # connector_offline is the v2 API error clients already translate.
    codes = set(get_args(e2ee.TunnelEndCode)) - {"closed", "too_large", "connector_offline"}
    assert codes <= set(messages["messages"]), codes - set(messages["messages"])
    e2ee.ClientTunnelEnd.model_validate({"t": "end", "route": {"deviceId": "d", "clientId": "cli_" + "a" * 26, "ch": "c"},
                                         "code": "pairing_expired"})


def test_e2ee_frame_body_limit_fits_one_noise_message() -> None:
    assert e2ee.FRAME_MAX_BODY_BYTES + 1 + e2ee.NOISE_TAG_BYTES == e2ee.NOISE_MAX_MESSAGE_BYTES
    formats = json.loads((E2EE_VECTORS / "aa-formats.json").read_text())
    for case in formats["framing"]:
        assert all(frame["bodyLength"] <= e2ee.FRAME_MAX_BODY_BYTES for frame in case["frames"])
        assert sum(frame["bodyLength"] for frame in case["frames"]) == case["messageLength"]
        assert [frame["flag"] for frame in case["frames"]][-1] == e2ee.FRAME_FINAL


def test_e2ee_noise_vectors_use_real_client_ids() -> None:
    noise = json.loads((E2EE_VECTORS / "aa-noise.json").read_text())
    for vector in noise["vectors"]:
        fields = bytes.fromhex(vector["init_prologue"]).split(b"\0")
        assert fields[0] == e2ee.PROLOGUE_LABEL.encode()
        assert any(e2ee.is_client_id(field.decode()) for field in fields)
    assert {v["protocol_name"] for v in noise["vectors"]} == {e2ee.NOISE_PAIRING_PROTOCOL, e2ee.NOISE_RECONNECT_PROTOCOL}


def test_required_mode_registers_no_content_methods() -> None:
    required = dl.registered_services("required")
    assert required["aa.device.v1.Secure"] == ["channel"]
    assert "aa.device.v1.Sessions" not in required and "aa.device.v1.Store" not in required
    assert "aa.device.v1.Runtime" not in required
    commands = set(required["aa.device.v1.Commands"])
    assert "sessionSendMessage" not in commands and "sessionSync" not in commands
    assert commands == {"status", "runtimeApply", "deviceSettingsApply", "channelSwitch", "previewOpen", "previewClose"}
    assert set(dl.E2EE_COMMAND_METHODS) <= set(dl.COMMAND_METHODS)
    assert set(dl.E2EE_EVENT_METHODS) <= set(dl.EVENT_METHODS)
    off = dl.registered_services("off")
    assert "aa.device.v1.Secure" not in off
    assert len(dl.registered_routes("off")) == len(dl.REQUEST_METHODS) + len(dl.COMMAND_METHODS) + 3


def test_scrub_for_e2ee_drops_results_and_error_text() -> None:
    scrubbed = dl.scrub_for_e2ee(
        "command.result",
        {"commandId": "c", "outcome": "rejected", "r": {"text": "secret"}, "e": {"code": "x", "message": "secret"}},
    )
    assert scrubbed["r"] is None and scrubbed["e"] == {"code": "x", "message": "", "retryable": False}
    assert dl.scrub_for_e2ee("usage.report", {"counters": []}) == {"counters": []}


def test_e2ee_subscriptions_name_their_target() -> None:
    import pytest
    from pydantic import ValidationError

    from agent_server.core import e2ee

    assert e2ee.TunnelSubscribe(id="s1", sessionId="sess").stream == "session"
    assert e2ee.TunnelSubscribe(id="s2", stream="terminal", terminalId="t1").terminalId == "t1"
    with pytest.raises(ValidationError):
        e2ee.TunnelSubscribe(id="s3", stream="terminal", sessionId="sess")
    with pytest.raises(ValidationError):
        e2ee.TunnelSubscribe(id="s4")


def test_e2ee_attachment_keys_and_file_chunks() -> None:
    import hashlib

    import pytest
    from pydantic import ValidationError

    from agent_server.core import e2ee

    digest = hashlib.sha256(b"hello").hexdigest()
    key = e2ee.SealedAttachmentKey(fileId="f1", key=e2ee.b64url(b"\x01" * 32), size=5, sha256=digest)
    # Segments are bound to the plaintext digest (the fileId does not exist yet when they are sealed).
    assert e2ee.sealed_segment_ad("attachment", key.sha256, 0, True).startswith(b"aa-e2ee/1.0\0attachment\0" + digest.encode())
    with pytest.raises(ValidationError):
        e2ee.SealedAttachmentKey(fileId="f1", key=key.key, size=5, sha256=digest.upper())
    chunk = e2ee.TunnelFileChunk(data="aGVsbG8=", offset=0, size=5, eof=True)
    assert chunk.encoding == "base64"
    named = e2ee.SealedAttachmentKey(fileId="f2", key=key.key, size=5, sha256=digest, name="报告.pdf", mimeType="application/pdf")
    assert named.name == "报告.pdf" and key.name is None
    assert e2ee.FILE_CHUNK_MAX_BYTES == 8 * 1024 * 1024
    assert e2ee.SEALED_UPLOAD_HEADER == "x-aa-sealed"
