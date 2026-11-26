"""Platform payload builders for APNs and FCM.

Privacy invariant: for encrypted devices the payload is rebuilt from fixed,
content-free constants (title, generic alert text, event type, device id) and
never reads ``envelope.title`` / ``envelope.body`` / ``envelope.session_id``,
even if a malformed job carried them.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Any

from aa_control.core.push import (
    DEFAULT_NORMAL_TITLES,
    ENCRYPTED_PUSH_TITLE,
    GENERIC_ENCRYPTED_ALERTS,
    HIGH_PRIORITY_EVENTS,
    PUSH_PAYLOAD_VERSION,
    PUSH_TTL_SECONDS,
)
from aa_control.infra.push.base import PushDeliveryEnvelope

DEFAULT_TTL_SECONDS = 3600
FALLBACK_TITLE = "Agents Anywhere"
FALLBACK_ENCRYPTED_ALERT = "加密设备有新动态，请打开客户端查看。"


@dataclass(frozen=True, slots=True)
class PushNotice:
    """Platform-neutral notification derived from a queued delivery envelope."""

    title: str
    body: str | None
    event_type: str
    device_id: str
    session_id: str | None
    encrypted_device: bool
    high_priority: bool
    ttl_seconds: int
    collapse_key: str | None
    thread_id: str


def _short_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def build_notice(envelope: PushDeliveryEnvelope) -> PushNotice:
    event_type = envelope.event_type
    high_priority = event_type in HIGH_PRIORITY_EVENTS
    ttl_seconds = PUSH_TTL_SECONDS.get(event_type, DEFAULT_TTL_SECONDS)

    if envelope.encrypted_device:
        body = GENERIC_ENCRYPTED_ALERTS.get(event_type, FALLBACK_ENCRYPTED_ALERT)
        return PushNotice(
            title=ENCRYPTED_PUSH_TITLE,
            body=body,
            event_type=event_type,
            device_id=envelope.device_id,
            session_id=None,
            encrypted_device=True,
            high_priority=high_priority,
            ttl_seconds=ttl_seconds,
            # Generic notices are interchangeable: keep only the latest per device + event type.
            collapse_key=f"aa-{event_type}-{_short_hash(envelope.device_id)}",
            thread_id=f"device:{envelope.device_id}",
        )

    default_title = DEFAULT_NORMAL_TITLES.get(event_type, FALLBACK_TITLE)
    title = envelope.title.strip() or default_title
    body = (envelope.body or "").strip() or None
    session_id = envelope.session_id or None
    collapse_key: str | None = None
    if event_type == "activity":
        # Progress updates for the same session replace each other; approvals and errors stack.
        collapse_key = f"aa-activity-{_short_hash(session_id or envelope.device_id)}"
    thread_id = f"session:{session_id}" if session_id else f"device:{envelope.device_id}"
    return PushNotice(
        title=title,
        body=body,
        event_type=event_type,
        device_id=envelope.device_id,
        session_id=session_id,
        encrypted_device=False,
        high_priority=high_priority,
        ttl_seconds=ttl_seconds,
        collapse_key=collapse_key,
        thread_id=thread_id,
    )


def _custom_data(notice: PushNotice) -> dict[str, Any]:
    data: dict[str, Any] = {
        "v": PUSH_PAYLOAD_VERSION,
        "event_type": notice.event_type,
        "device_id": notice.device_id,
        "encrypted": notice.encrypted_device,
    }
    if notice.session_id is not None:
        data["session_id"] = notice.session_id
    return data


def build_apns_payload(notice: PushNotice) -> dict[str, Any]:
    alert: dict[str, str] = {"title": notice.title}
    if notice.body is not None:
        alert["body"] = notice.body
    aps: dict[str, Any] = {
        "alert": alert,
        "sound": "default",
        "thread-id": notice.thread_id,
    }
    return {"aps": aps, "aa": _custom_data(notice)}


def build_fcm_message(notice: PushNotice, *, token: str) -> dict[str, Any]:
    notification: dict[str, str] = {"title": notice.title}
    if notice.body is not None:
        notification["body"] = notice.body
    # FCM data values must be strings.
    data = {f"aa_{key}": _fcm_data_value(value) for key, value in _custom_data(notice).items()}
    android: dict[str, Any] = {
        "priority": "HIGH" if notice.high_priority else "NORMAL",
        "ttl": f"{notice.ttl_seconds}s",
    }
    android_notification: dict[str, str] = {}
    if notice.collapse_key is not None:
        android["collapse_key"] = notice.collapse_key
        android_notification["tag"] = notice.collapse_key
    if android_notification:
        android["notification"] = android_notification
    return {
        "message": {
            "token": token,
            "notification": notification,
            "data": data,
            "android": android,
        }
    }


def _fcm_data_value(value: Any) -> str:
    if isinstance(value, bool):
        return "1" if value else "0"
    return str(value)
