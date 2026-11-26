from __future__ import annotations

import json
from pathlib import Path

import jsonschema

from aa_control.core.models import (
    DeviceAdminCheckUpdateRequest,
    DeviceAdminCloseTunnelSessionsRequest,
    DeviceAdminPingResponse,
    DeviceAdminRenameRequest,
    DeviceError,
    DeviceRecord,
    DeviceSessionResult,
    ListSessionsOnceResponse,
    ListSessionsRequest,
    NormalDeviceSummary,
    OpenTunnelRequest,
    OpenTunnelResponse,
    PresenceReport,
    PushNotificationRequest,
    RegisterClientPushRequest,
    SessionListPayload,
    SessionSummary,
    WatchDevicesEvent,
)

SCHEMA_PATH = Path(__file__).parents[2] / "contracts" / "aa-v3" / "1.0" / "control.schema.json"


def _validator(def_name: str) -> jsonschema.Draft202012Validator:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    sub = {"$schema": schema["$schema"], "$defs": schema["$defs"], "$ref": f"#/$defs/{def_name}"}
    return jsonschema.Draft202012Validator(sub)


def test_all_control_models_match_v3_contract_schema() -> None:
    sample_key = "A" * 43
    now = "2026-11-21T08:00:00Z"

    device = DeviceRecord(
        id="dev_1",
        name="Mac Studio",
        platform="macos",
        connector_version="3.0.0",
        mode_hint="normal",
        presence="online",
        created_at=now,
        last_seen_at=now,
        summary=NormalDeviceSummary(runtimes=["codex"], active_sessions=2, pending_approvals=1),
    )
    _validator("DeviceRecord").validate(device.model_dump(exclude_none=True))

    enc_device = DeviceRecord(
        id="dev_enc",
        name="Private Workstation",
        platform="linux",
        connector_version="3.0.0",
        mode_hint="encrypted",
        presence="online",
        created_at=now,
        last_seen_at=now,
        e2e_public_key_hint=sample_key,
    )
    _validator("DeviceRecord").validate(enc_device.model_dump(exclude_none=True))

    report = PresenceReport(
        device_id="dev_1",
        platform="macos",
        connector_version="3.0.0",
        mode_hint="normal",
        sent_at=now,
        summary=NormalDeviceSummary(runtimes=["codex", "claude"], active_sessions=1, pending_approvals=0),
    )
    _validator("PresenceReport").validate(report.model_dump(exclude_none=True))

    for ev in [
        WatchDevicesEvent(type="snapshot", devices=[device, enc_device]),
        WatchDevicesEvent(type="upsert", device=device),
        WatchDevicesEvent(type="remove", device_id="dev_1"),
    ]:
        _validator("WatchDevicesEvent").validate(ev.to_contract_dict())

    _validator("OpenTunnelRequest").validate(
        OpenTunnelRequest(device_id="dev_enc", client_id="cli_1", e2e_key=sample_key).model_dump(exclude_none=True)
    )
    _validator("OpenTunnelResponse").validate(
        OpenTunnelResponse(
            router_url="wss://router.example.test",
            credential="mtun_e2e.abc123",
            tunnel_id="tun_1",
            expires_at=now,
            mode="encrypted",
        ).model_dump(exclude_none=True)
    )

    session = SessionSummary(
        id="sess_1",
        title="Refactor",
        agent="codex",
        device_id="dev_1",
        cwd="/repo",
        state="running",
        unread=True,
        pinned=False,
        updated_at=now,
    )
    res_ok = DeviceSessionResult(
        device_id="dev_1",
        status="ok",
        value=SessionListPayload(sessions=[session], projects=["/repo"]),
    )
    res_err = DeviceSessionResult(
        device_id="dev_2",
        status="timeout",
        error=DeviceError(code="timeout", message="timed out"),
    )
    res_enc = DeviceSessionResult(device_id="dev_enc", status="encrypted")
    for r in (res_ok, res_err, res_enc):
        _validator("DeviceSessionResult").validate(r.model_dump(exclude_none=True))

    _validator("ListSessionsRequest").validate(
        ListSessionsRequest(device_ids=["dev_1"], limit_per_device=50).model_dump(exclude_none=True)
    )
    _validator("ListSessionsOnceResponse").validate(
        ListSessionsOnceResponse(results=[res_ok, res_enc]).model_dump(exclude_none=True)
    )

    _validator("DeviceAdminPingResponse").validate(DeviceAdminPingResponse(server_time=now).model_dump())
    _validator("DeviceAdminCloseTunnelSessionsRequest").validate(
        DeviceAdminCloseTunnelSessionsRequest(tunnel_id="tun_1").model_dump()
    )
    _validator("DeviceAdminCheckUpdateRequest").validate(
        DeviceAdminCheckUpdateRequest(channel="stable").model_dump(exclude_none=True)
    )
    _validator("DeviceAdminRenameRequest").validate(DeviceAdminRenameRequest(name="New Name").model_dump())
    _validator("PushNotificationRequest").validate(
        PushNotificationRequest(device_id="dev_1", event_type="approval", title="Need OK").model_dump(exclude_none=True)
    )
    _validator("RegisterClientPushRequest").validate(
        RegisterClientPushRequest(client_id="cli_1", platform="ios", push_token="apns_tok").model_dump(exclude_none=True)
    )
