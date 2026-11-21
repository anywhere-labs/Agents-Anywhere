from __future__ import annotations

import time

from aa_control.core.models import (
    PushNotificationRequest,
    RegisterClientPushRequest,
    RegisterDeviceRequest,
)
from aa_control.infra.push import PushRetryWorker
from tests.conftest import RecordingPushProvider


async def test_encrypted_device_push_strips_all_content_and_normal_preserves_summary(
    app,
    push_provider: RecordingPushProvider,
) -> None:
    user = await app.state.repo.create_user(email="push@example.com", password_hash="x", display_name="P")
    await app.state.device_service.register_client_push_token(
        user_id=user.id,
        req=RegisterClientPushRequest(client_id="ios_1", platform="ios", push_token="apns_token_123"),
    )
    normal = (
        await app.state.device_service.register_device(
            user_id=user.id,
            req=RegisterDeviceRequest(name="Normal", platform="macos", mode_hint="normal"),
            actor=f"user:{user.id}",
        )
    ).device
    encrypted = (
        await app.state.device_service.register_device(
            user_id=user.id,
            req=RegisterDeviceRequest(name="Encrypted", platform="linux", mode_hint="encrypted"),
            actor=f"user:{user.id}",
        )
    ).device

    # Encrypted device tries to send private title/body/session_id -> MUST be stripped!
    enc_ack = await app.state.push_service.notify_from_device(
        authenticated_device_id=encrypted.id,
        req=PushNotificationRequest(
            device_id=encrypted.id,
            event_type="approval",
            session_id="secret_sess_99",
            title="SUPER SECRET PROMPT",
            body="rm -rf /secret/project",
        ),
    )
    assert enc_ack.queued == 1
    assert enc_ack.content_stripped is True

    # Normal device sends summary -> preserved
    norm_ack = await app.state.push_service.notify_from_device(
        authenticated_device_id=normal.id,
        req=PushNotificationRequest(
            device_id=normal.id,
            event_type="activity",
            session_id="sess_1",
            title="Build finished",
            body="All 42 tests passed",
        ),
    )
    assert norm_ack.queued == 1
    assert norm_ack.content_stripped is False

    while await app.state.push_worker.process_once():
        pass

    assert len(push_provider.sent) == 2
    enc_env = push_provider.sent[0]
    assert enc_env.encrypted_device is True
    assert enc_env.session_id is None
    assert "SECRET" not in enc_env.title
    assert "rm -rf" not in (enc_env.body or "")
    assert enc_env.title == "Agents Anywhere"

    norm_env = push_provider.sent[1]
    assert norm_env.encrypted_device is False
    assert norm_env.session_id == "sess_1"
    assert norm_env.title == "Build finished"
    assert norm_env.body == "All 42 tests passed"


async def test_push_retry_backoff_and_dead_letter_queue(app) -> None:
    user = await app.state.repo.create_user(email="retry@example.com", password_hash="x", display_name="R")
    await app.state.device_service.register_client_push_token(
        user_id=user.id,
        req=RegisterClientPushRequest(client_id="and_1", platform="android", push_token="fcm_token_xyz"),
    )
    dev = (
        await app.state.device_service.register_device(
            user_id=user.id,
            req=RegisterDeviceRequest(name="Dev", platform="linux", mode_hint="normal"),
            actor=f"user:{user.id}",
        )
    ).device

    # Fails twice, succeeds on 3rd attempt
    flaky_provider = RecordingPushProvider(fail_times=2)
    worker = PushRetryWorker(
        app.state.redis_store,
        flaky_provider,
        max_attempts=3,
        base_backoff_seconds=2.0,
    )
    await app.state.push_service.notify_from_device(
        authenticated_device_id=dev.id,
        req=PushNotificationRequest(device_id=dev.id, event_type="activity", title="Ping"),
    )

    t0 = time.time()
    # Attempt 1 fails -> delayed by 2s
    assert await worker.process_once(now_unix=t0) is True
    assert len(flaky_provider.sent) == 0
    assert (await app.state.redis_store.push_queue_lengths())["delayed"] == 1

    # Too early -> not promoted
    assert await worker.process_once(now_unix=t0 + 1.0) is False

    # Attempt 2 at t0+2.5 fails -> delayed by 4s
    assert await worker.process_once(now_unix=t0 + 2.5) is True
    assert len(flaky_provider.sent) == 0

    # Attempt 3 at t0+7.0 succeeds!
    assert await worker.process_once(now_unix=t0 + 7.0) is True
    assert len(flaky_provider.sent) == 1
    assert flaky_provider.sent[0].attempt == 3

    # Permanent failure exhausts retries -> moves to dead queue
    dead_provider = RecordingPushProvider(fail_times=10)
    dead_worker = PushRetryWorker(app.state.redis_store, dead_provider, max_attempts=2, base_backoff_seconds=1.0)
    await app.state.push_service.notify_from_device(
        authenticated_device_id=dev.id,
        req=PushNotificationRequest(device_id=dev.id, event_type="error", title="Fail"),
    )
    assert await dead_worker.process_once(now_unix=t0 + 10.0) is True
    assert await dead_worker.process_once(now_unix=t0 + 12.0) is True
    assert (await app.state.redis_store.push_queue_lengths())["dead"] == 1
