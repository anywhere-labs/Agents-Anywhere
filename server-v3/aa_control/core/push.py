"""Push notification constants shared by the enqueue service and platform senders.

Hard privacy invariant: notices about encrypted devices carry only the fixed,
content-free texts below. Senders rebuild encrypted payloads from these
constants instead of trusting whatever title/body the queued job holds.
"""

from __future__ import annotations

from aa_control.core.models import PushEventType

ENCRYPTED_PUSH_TITLE = "Agents Anywhere"

GENERIC_ENCRYPTED_ALERTS: dict[PushEventType, str] = {
    "approval": "您有一条待处理的审批请求，请打开客户端查看。",
    "activity": "加密设备有新动态，请打开客户端查看。",
    "error": "加密设备有状态提醒，请打开客户端查看。",
}

DEFAULT_NORMAL_TITLES: dict[PushEventType, str] = {
    "approval": "待处理审批",
    "activity": "会话更新",
    "error": "运行异常",
}

# How long APNs / FCM keep an undelivered notice before dropping it.
PUSH_TTL_SECONDS: dict[PushEventType, int] = {
    "approval": 24 * 3600,
    "activity": 3600,
    "error": 24 * 3600,
}

# Approvals and errors wake the device immediately; activity may be batched for power.
HIGH_PRIORITY_EVENTS: frozenset[PushEventType] = frozenset({"approval", "error"})

PUSH_PAYLOAD_VERSION = 1
