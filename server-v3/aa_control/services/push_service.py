from __future__ import annotations

import secrets

from aa_control.core.errors import ForbiddenError, NotFoundError
from aa_control.core.models import PushEventType, PushNotificationAck, PushNotificationRequest
from aa_control.core.utc import utc_now_iso
from aa_control.infra.db.repositories import ControlRepository
from aa_control.infra.redis_store import RedisControlStore

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


class PushService:
    """Enqueues push notifications into Redis retry queue.

    Hard privacy invariant: encrypted devices NEVER include conversation titles,
    message bodies, or session IDs in push payloads — only a content-free alert.
    """

    def __init__(
        self,
        *,
        repo: ControlRepository,
        redis_store: RedisControlStore,
    ) -> None:
        self._repo = repo
        self._redis = redis_store

    async def notify_from_device(
        self,
        *,
        authenticated_device_id: str,
        req: PushNotificationRequest,
    ) -> PushNotificationAck:
        if req.device_id != authenticated_device_id:
            raise ForbiddenError("push device_id does not match authenticated device")
        device = await self._repo.get_device(authenticated_device_id)
        if device is None:
            raise NotFoundError(f"device {authenticated_device_id} not found")

        presence = await self._redis.get_presence(device.id)
        effective_mode = presence.mode_hint if presence is not None else device.mode_hint
        is_encrypted = effective_mode == "encrypted"

        if is_encrypted:
            # Strictly strip all content and session identifiers for encrypted devices.
            title = "Agents Anywhere"
            body: str | None = GENERIC_ENCRYPTED_ALERTS[req.event_type]
            session_id: str | None = None
            content_stripped = True
        else:
            title = (req.title or "").strip() or DEFAULT_NORMAL_TITLES[req.event_type]
            body = (req.body or "").strip() or None
            session_id = req.session_id
            content_stripped = False

        clients = await self._repo.list_push_clients_for_user(device.user_id)
        queued = 0
        for client in clients:
            if not client.push_token:
                continue
            job = {
                "job_id": f"push_{secrets.token_hex(10)}",
                "client_id": client.id,
                "platform": client.platform,
                "push_token": client.push_token,
                "device_id": device.id,
                "event_type": req.event_type,
                "encrypted_device": is_encrypted,
                "title": title,
                "body": body,
                "session_id": session_id,
                "attempt": 0,
                "created_at": utc_now_iso(),
            }
            await self._redis.enqueue_push_job(job)
            queued += 1

        return PushNotificationAck(queued=queued, content_stripped=content_stripped)
