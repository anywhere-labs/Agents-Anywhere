from __future__ import annotations

import json
import time
from collections.abc import Callable

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from loguru import logger

from aa_control.app import create_app
from aa_control.core.config import (
    ApnsConfig,
    ControlSettings,
    FcmConfig,
    PushConfig,
    parse_fcm_service_account,
)
from aa_control.core.models import (
    PushNotificationRequest,
    RegisterClientPushRequest,
    RegisterDeviceRequest,
)
from aa_control.core.push import ENCRYPTED_PUSH_TITLE, GENERIC_ENCRYPTED_ALERTS
from aa_control.infra.push import (
    ApnsProviderToken,
    ApnsSender,
    FcmSender,
    PlatformPushProvider,
    PushDeliveryEnvelope,
    PushPermanentError,
    PushRetryableError,
    PushRetryWorker,
    PushTokenInvalidError,
    build_push_provider,
)

APNS_TOKEN = "a1b2c3d4e5f6apnsdevicetoken0123456789"
FCM_TOKEN = "fcm-registration-token-xyz-0123456789"
SECRET_TITLE = "SUPER SECRET PROMPT"
SECRET_BODY = "rm -rf /secret/project"
SECRET_SESSION = "secret_sess_99"

Handler = Callable[[httpx.Request], httpx.Response]


class FakeClock:
    def __init__(self, now: float | None = None) -> None:
        # Start at real time so PyJWT's iat/exp checks accept tokens signed with this clock.
        self.now = time.time() if now is None else now

    def __call__(self) -> float:
        return self.now


@pytest.fixture(scope="module")
def ec_key() -> ec.EllipticCurvePrivateKey:
    return ec.generate_private_key(ec.SECP256R1())


@pytest.fixture(scope="module")
def ec_pem(ec_key: ec.EllipticCurvePrivateKey) -> str:
    return ec_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


@pytest.fixture(scope="module")
def rsa_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


@pytest.fixture(scope="module")
def rsa_pem(rsa_key: rsa.RSAPrivateKey) -> str:
    return rsa_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()


@pytest.fixture
def apns_config(ec_pem: str) -> ApnsConfig:
    return ApnsConfig(
        key_id="KEY1234567",
        team_id="TEAM123456",
        bundle_id="dev.anywhere.agents",
        private_key_pem=ec_pem,
        environment="sandbox",
    )


@pytest.fixture
def fcm_config(rsa_pem: str) -> FcmConfig:
    return FcmConfig(
        project_id="aa-test-project",
        client_email="push@aa-test-project.iam.gserviceaccount.com",
        private_key_pem=rsa_pem,
        private_key_id="sa-key-id-1",
        token_uri="https://oauth2.googleapis.test/token",
    )


def _envelope(
    *,
    platform: str = "ios",
    encrypted: bool = False,
    event_type: str = "approval",
    token: str = APNS_TOKEN,
    title: str = "Build finished",
    body: str | None = "All 42 tests passed",
    session_id: str | None = "sess_1",
) -> PushDeliveryEnvelope:
    return PushDeliveryEnvelope(
        job_id="push_job_1",
        client_id="client_1",
        platform=platform,
        push_token=token,
        device_id="dev_1",
        event_type=event_type,
        encrypted_device=encrypted,
        title=title,
        body=body,
        session_id=session_id,
        attempt=1,
    )


def _apns_sender(config: ApnsConfig, handler: Handler, clock: FakeClock | None = None) -> ApnsSender:
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return ApnsSender(config, http_client=client, clock=clock or FakeClock())


class FcmStub:
    """Mock Google OAuth token endpoint + FCM messages:send."""

    def __init__(self, send_responses: list[httpx.Response] | None = None, *, expires_in: int = 3600) -> None:
        self.token_requests: list[httpx.Request] = []
        self.send_requests: list[httpx.Request] = []
        self._send_responses = list(send_responses or [])
        self._expires_in = expires_in

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/token":
            self.token_requests.append(request)
            n = len(self.token_requests)
            return httpx.Response(
                200,
                json={"access_token": f"ya29.access-{n}", "expires_in": self._expires_in, "token_type": "Bearer"},
            )
        self.send_requests.append(request)
        if self._send_responses:
            return self._send_responses.pop(0)
        return httpx.Response(200, json={"name": "projects/aa-test-project/messages/0:1"})


def _fcm_sender(config: FcmConfig, stub: FcmStub, clock: FakeClock | None = None) -> FcmSender:
    client = httpx.AsyncClient(transport=httpx.MockTransport(stub))
    return FcmSender(config, http_client=client, clock=clock or FakeClock())


def _fcm_error(code: int, status: str, *, fcm_code: str | None = None, field: str | None = None,
               message: str = "error") -> httpx.Response:
    details: list[dict] = []
    if fcm_code is not None:
        details.append({"@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", "errorCode": fcm_code})
    if field is not None:
        details.append(
            {
                "@type": "type.googleapis.com/google.rpc.BadRequest",
                "fieldViolations": [{"field": field, "description": "bad"}],
            }
        )
    return httpx.Response(
        code,
        json={"error": {"code": code, "status": status, "message": message, "details": details}},
    )


# ---------------------------------------------------------------------------
# APNs
# ---------------------------------------------------------------------------


def test_apns_provider_jwt_shape_and_caching(ec_key: ec.EllipticCurvePrivateKey, ec_pem: str) -> None:
    clock = FakeClock()
    provider = ApnsProviderToken(key_id="KEY1234567", team_id="TEAM123456", private_key_pem=ec_pem, clock=clock)

    first = provider.get()
    header = jwt.get_unverified_header(first)
    assert header == {"alg": "ES256", "kid": "KEY1234567"}
    claims = jwt.decode(first, ec_key.public_key(), algorithms=["ES256"])
    assert claims == {"iss": "TEAM123456", "iat": int(clock.now)}

    clock.now += 49 * 60
    assert provider.get() == first, "token must be reused inside the refresh window"

    clock.now += 2 * 60  # 51 minutes after issue: before Apple's 60 minute limit
    refreshed = provider.get()
    assert refreshed != first
    # The fake clock now runs ahead of real time, so skip PyJWT's "iat in the future" check.
    refreshed_claims = jwt.decode(
        refreshed,
        ec_key.public_key(),
        algorithms=["ES256"],
        options={"verify_iat": False},
    )
    assert refreshed_claims["iat"] == int(clock.now)

    provider.invalidate()
    clock.now += 1
    assert provider.get() != refreshed


def test_apns_rejects_non_p256_key(rsa_pem: str) -> None:
    with pytest.raises(ValueError, match="EC P-256"):
        ApnsProviderToken(key_id="K", team_id="T", private_key_pem=rsa_pem)
    with pytest.raises(ValueError, match="not a valid"):
        ApnsProviderToken(key_id="K", team_id="T", private_key_pem="-----BEGIN PRIVATE KEY-----\nnope\n")


async def test_apns_request_shape_and_host(apns_config: ApnsConfig, ec_key: ec.EllipticCurvePrivateKey) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200)

    clock = FakeClock()
    sender = _apns_sender(apns_config, handler, clock)
    await sender.send(_envelope(event_type="approval"))
    await sender.send(_envelope(event_type="activity"))

    approval, activity = seen
    assert str(approval.url) == f"https://api.sandbox.push.apple.com/3/device/{APNS_TOKEN}"
    assert approval.headers["apns-topic"] == "dev.anywhere.agents"
    assert approval.headers["apns-push-type"] == "alert"
    assert approval.headers["apns-priority"] == "10"
    assert approval.headers["apns-expiration"] == str(int(clock.now) + 24 * 3600)
    assert "apns-collapse-id" not in approval.headers
    bearer = approval.headers["authorization"].removeprefix("bearer ")
    assert jwt.decode(bearer, ec_key.public_key(), algorithms=["ES256"])["iss"] == "TEAM123456"
    body = json.loads(approval.content)
    assert body["aps"]["alert"] == {"title": "Build finished", "body": "All 42 tests passed"}
    assert body["aa"] == {"v": 1, "event_type": "approval", "device_id": "dev_1", "encrypted": False,
                          "session_id": "sess_1"}

    assert activity.headers["apns-priority"] == "5"
    assert activity.headers["apns-expiration"] == str(int(clock.now) + 3600)
    assert activity.headers["apns-collapse-id"].startswith("aa-activity-")
    assert len(activity.headers["apns-collapse-id"].encode()) <= 64
    # Same provider JWT reused for the second request.
    assert activity.headers["authorization"] == approval.headers["authorization"]

    prod = ApnsConfig(
        key_id=apns_config.key_id,
        team_id=apns_config.team_id,
        bundle_id=apns_config.bundle_id,
        private_key_pem=apns_config.private_key_pem,
    )
    seen.clear()
    await _apns_sender(prod, handler).send(_envelope())
    assert seen[0].url.host == "api.push.apple.com"


@pytest.mark.parametrize(
    ("status", "reason", "expected"),
    [
        (410, "Unregistered", PushTokenInvalidError),
        (400, "BadDeviceToken", PushTokenInvalidError),
        (429, "TooManyRequests", PushRetryableError),
        (500, "InternalServerError", PushRetryableError),
        (503, "ServiceUnavailable", PushRetryableError),
        (403, "ExpiredProviderToken", PushRetryableError),
        (400, "BadTopic", PushPermanentError),
        (400, "PayloadTooLarge", PushPermanentError),
        (403, "InvalidProviderToken", PushPermanentError),
        (413, "PayloadTooLarge", PushPermanentError),
    ],
)
async def test_apns_response_mapping(
    apns_config: ApnsConfig,
    status: int,
    reason: str,
    expected: type[Exception],
) -> None:
    sender = _apns_sender(apns_config, lambda _r: httpx.Response(status, json={"reason": reason}))
    with pytest.raises(expected) as info:
        await sender.send(_envelope())
    assert APNS_TOKEN not in str(info.value)
    assert reason in str(info.value)


async def test_apns_expired_provider_token_is_resigned(apns_config: ApnsConfig) -> None:
    auth_headers: list[str] = []
    responses = [httpx.Response(403, json={"reason": "ExpiredProviderToken"}), httpx.Response(200)]

    def handler(request: httpx.Request) -> httpx.Response:
        auth_headers.append(request.headers["authorization"])
        return responses.pop(0)

    clock = FakeClock()
    sender = _apns_sender(apns_config, handler, clock)
    with pytest.raises(PushRetryableError):
        await sender.send(_envelope())
    clock.now += 1
    await sender.send(_envelope())
    assert auth_headers[0] != auth_headers[1]


async def test_apns_connection_error_is_retryable_and_hides_token(apns_config: ApnsConfig) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"connection refused for {request.url}", request=request)

    sender = _apns_sender(apns_config, handler)
    with pytest.raises(PushRetryableError) as info:
        await sender.send(_envelope())
    assert APNS_TOKEN not in str(info.value)
    assert "ConnectError" in str(info.value)


# ---------------------------------------------------------------------------
# FCM
# ---------------------------------------------------------------------------


async def test_fcm_oauth_assertion_and_access_token_caching(
    fcm_config: FcmConfig,
    rsa_key: rsa.RSAPrivateKey,
) -> None:
    clock = FakeClock()
    stub = FcmStub(expires_in=3600)
    sender = _fcm_sender(fcm_config, stub, clock)

    await sender.send(_envelope(platform="android", token=FCM_TOKEN))
    await sender.send(_envelope(platform="android", token=FCM_TOKEN))
    assert len(stub.token_requests) == 1, "access token must be cached"

    form = httpx.QueryParams(stub.token_requests[0].content.decode())
    assert form["grant_type"] == "urn:ietf:params:oauth:grant-type:jwt-bearer"
    assertion = form["assertion"]
    assert jwt.get_unverified_header(assertion)["kid"] == "sa-key-id-1"
    claims = jwt.decode(
        assertion,
        rsa_key.public_key(),
        algorithms=["RS256"],
        audience="https://oauth2.googleapis.test/token",
    )
    assert claims["iss"] == fcm_config.client_email
    assert claims["scope"] == "https://www.googleapis.com/auth/firebase.messaging"
    assert claims["exp"] - claims["iat"] == 3600

    send = stub.send_requests[0]
    assert str(send.url) == "https://fcm.googleapis.com/v1/projects/aa-test-project/messages:send"
    assert send.headers["authorization"] == "Bearer ya29.access-1"
    message = json.loads(send.content)["message"]
    assert message["token"] == FCM_TOKEN
    assert message["notification"] == {"title": "Build finished", "body": "All 42 tests passed"}
    assert message["data"] == {
        "aa_v": "1",
        "aa_event_type": "approval",
        "aa_device_id": "dev_1",
        "aa_encrypted": "0",
        "aa_session_id": "sess_1",
    }
    assert message["android"]["priority"] == "HIGH"
    assert message["android"]["ttl"] == "86400s"

    # Refreshed 5 minutes before Google's expiry.
    clock.now += 3600 - 299
    await sender.send(_envelope(platform="android", token=FCM_TOKEN))
    assert len(stub.token_requests) == 2
    assert stub.send_requests[-1].headers["authorization"] == "Bearer ya29.access-2"


async def test_fcm_401_drops_cached_access_token(fcm_config: FcmConfig) -> None:
    stub = FcmStub([_fcm_error(401, "UNAUTHENTICATED")])
    sender = _fcm_sender(fcm_config, stub)
    with pytest.raises(PushRetryableError):
        await sender.send(_envelope(platform="android", token=FCM_TOKEN))
    await sender.send(_envelope(platform="android", token=FCM_TOKEN))
    assert len(stub.token_requests) == 2


@pytest.mark.parametrize(
    ("response", "expected"),
    [
        (_fcm_error(404, "NOT_FOUND", fcm_code="UNREGISTERED"), PushTokenInvalidError),
        (_fcm_error(400, "INVALID_ARGUMENT", fcm_code="INVALID_ARGUMENT", field="message.token"),
         PushTokenInvalidError),
        (_fcm_error(400, "INVALID_ARGUMENT", message="The registration token is not a valid FCM registration token"),
         PushTokenInvalidError),
        (_fcm_error(400, "INVALID_ARGUMENT", fcm_code="INVALID_ARGUMENT", field="message.android.ttl"),
         PushPermanentError),
        (_fcm_error(503, "UNAVAILABLE", fcm_code="UNAVAILABLE"), PushRetryableError),
        (_fcm_error(500, "INTERNAL", fcm_code="INTERNAL"), PushRetryableError),
        (_fcm_error(429, "RESOURCE_EXHAUSTED", fcm_code="QUOTA_EXCEEDED"), PushRetryableError),
        (_fcm_error(403, "PERMISSION_DENIED", fcm_code="SENDER_ID_MISMATCH"), PushPermanentError),
        (httpx.Response(502, text="<html>bad gateway</html>"), PushRetryableError),
    ],
)
async def test_fcm_response_mapping(
    fcm_config: FcmConfig,
    response: httpx.Response,
    expected: type[Exception],
) -> None:
    sender = _fcm_sender(fcm_config, FcmStub([response]))
    with pytest.raises(expected) as info:
        await sender.send(_envelope(platform="android", token=FCM_TOKEN))
    assert FCM_TOKEN not in str(info.value)


async def test_fcm_retry_after_header_is_propagated(fcm_config: FcmConfig) -> None:
    response = _fcm_error(503, "UNAVAILABLE", fcm_code="UNAVAILABLE")
    response.headers["Retry-After"] = "42"
    sender = _fcm_sender(fcm_config, FcmStub([response]))
    with pytest.raises(PushRetryableError) as info:
        await sender.send(_envelope(platform="android", token=FCM_TOKEN))
    assert info.value.retry_after_seconds == 42.0


async def test_fcm_oauth_failures_are_classified(fcm_config: FcmConfig) -> None:
    def unavailable(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(503)

    def rejected(_r: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"error": "invalid_grant"})

    for handler, expected in ((unavailable, PushRetryableError), (rejected, PushPermanentError)):
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        sender = FcmSender(fcm_config, http_client=client)
        with pytest.raises(expected):
            await sender.send(_envelope(platform="android", token=FCM_TOKEN))


# ---------------------------------------------------------------------------
# Privacy: encrypted devices never carry content
# ---------------------------------------------------------------------------


def _assert_no_content(raw: bytes) -> None:
    text = raw.decode("utf-8")
    for secret in (SECRET_TITLE, SECRET_BODY, SECRET_SESSION):
        assert secret not in text
    assert "session_id" not in text


async def test_encrypted_payloads_contain_no_content_fields(
    apns_config: ApnsConfig,
    fcm_config: FcmConfig,
) -> None:
    """Even if a queued job carried content, encrypted payloads are rebuilt from fixed texts."""
    leaky = _envelope(
        encrypted=True,
        event_type="approval",
        title=SECRET_TITLE,
        body=SECRET_BODY,
        session_id=SECRET_SESSION,
    )

    apns_seen: list[httpx.Request] = []

    def apns_handler(request: httpx.Request) -> httpx.Response:
        apns_seen.append(request)
        return httpx.Response(200)

    await _apns_sender(apns_config, apns_handler).send(leaky)
    apns_body = json.loads(apns_seen[0].content)
    _assert_no_content(apns_seen[0].content)
    assert apns_body["aps"]["alert"] == {"title": ENCRYPTED_PUSH_TITLE, "body": GENERIC_ENCRYPTED_ALERTS["approval"]}
    assert set(apns_body["aa"]) == {"v", "event_type", "device_id", "encrypted"}
    assert apns_body["aa"]["encrypted"] is True
    assert apns_body["aps"]["thread-id"] == "device:dev_1"
    assert "mutable-content" not in apns_body["aps"]
    for value in apns_seen[0].headers.values():
        assert SECRET_SESSION not in value

    stub = FcmStub()
    fcm_leaky = _envelope(
        platform="android",
        token=FCM_TOKEN,
        encrypted=True,
        event_type="activity",
        title=SECRET_TITLE,
        body=SECRET_BODY,
        session_id=SECRET_SESSION,
    )
    await _fcm_sender(fcm_config, stub).send(fcm_leaky)
    _assert_no_content(stub.send_requests[0].content)
    message = json.loads(stub.send_requests[0].content)["message"]
    assert message["notification"] == {"title": ENCRYPTED_PUSH_TITLE, "body": GENERIC_ENCRYPTED_ALERTS["activity"]}
    assert set(message["data"]) == {"aa_v", "aa_event_type", "aa_device_id", "aa_encrypted"}
    assert message["data"]["aa_encrypted"] == "1"


# ---------------------------------------------------------------------------
# Pipeline integration: worker + real senders over mocked HTTP
# ---------------------------------------------------------------------------


class ApnsScript:
    def __init__(self, responses: list[httpx.Response]) -> None:
        self.requests: list[httpx.Request] = []
        self._responses = responses

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self._responses:
            return self._responses.pop(0)
        return httpx.Response(200)


@pytest.fixture
def capture_logs():
    lines: list[str] = []
    sink_id = logger.add(lambda message: lines.append(str(message)), level="DEBUG")
    try:
        yield lines
    finally:
        logger.remove(sink_id)


async def _setup_user(app, *, encrypted: bool = False):
    user = await app.state.repo.create_user(email="senders@example.com", password_hash="x", display_name="S")
    await app.state.device_service.register_client_push_token(
        user_id=user.id,
        req=RegisterClientPushRequest(client_id="ios_1", platform="ios", push_token=APNS_TOKEN),
    )
    await app.state.device_service.register_client_push_token(
        user_id=user.id,
        req=RegisterClientPushRequest(client_id="and_1", platform="android", push_token=FCM_TOKEN),
    )
    await app.state.device_service.register_client_push_token(
        user_id=user.id,
        req=RegisterClientPushRequest(client_id="desk_1", platform="desktop", push_token="desktop-token"),
    )
    device = (
        await app.state.device_service.register_device(
            user_id=user.id,
            req=RegisterDeviceRequest(
                name="Dev",
                platform="linux",
                mode_hint="encrypted" if encrypted else "normal",
            ),
            actor=f"user:{user.id}",
        )
    ).device
    return user, device


def _make_app(settings, db_engine, redis_client, router_pool, provider):
    return create_app(
        settings=settings,
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=provider,
        start_push_worker=False,
    )


async def test_pipeline_delivers_encrypted_notice_through_real_senders(
    settings, db_engine, redis_client, router_pool, apns_config, fcm_config,
) -> None:
    apns = ApnsScript([])
    fcm = FcmStub()
    provider = PlatformPushProvider(apns=_apns_sender(apns_config, apns), fcm=_fcm_sender(fcm_config, fcm))
    app = _make_app(settings, db_engine, redis_client, router_pool, provider)
    _user, device = await _setup_user(app, encrypted=True)

    ack = await app.state.push_service.notify_from_device(
        authenticated_device_id=device.id,
        req=PushNotificationRequest(
            device_id=device.id,
            event_type="approval",
            session_id=SECRET_SESSION,
            title=SECRET_TITLE,
            body=SECRET_BODY,
        ),
    )
    assert ack.queued == 3 and ack.content_stripped is True
    while await app.state.push_worker.process_once():
        pass

    assert len(apns.requests) == 1
    assert len(fcm.send_requests) == 1
    _assert_no_content(apns.requests[0].content)
    _assert_no_content(fcm.send_requests[0].content)
    lengths = await app.state.redis_store.push_queue_lengths()
    assert lengths == {"ready": 0, "delayed": 0, "dead": 0}


async def test_pipeline_removes_dead_tokens_and_dead_letters_permanent_failures(
    settings, db_engine, redis_client, router_pool, apns_config, fcm_config, capture_logs,
) -> None:
    apns = ApnsScript([httpx.Response(410, json={"reason": "Unregistered", "timestamp": 1})])
    fcm = FcmStub([_fcm_error(400, "INVALID_ARGUMENT", fcm_code="INVALID_ARGUMENT", field="message.android.ttl")])
    provider = PlatformPushProvider(apns=_apns_sender(apns_config, apns), fcm=_fcm_sender(fcm_config, fcm))
    app = _make_app(settings, db_engine, redis_client, router_pool, provider)
    user, device = await _setup_user(app)

    await app.state.push_service.notify_from_device(
        authenticated_device_id=device.id,
        req=PushNotificationRequest(device_id=device.id, event_type="activity", title="Hi", body=SECRET_BODY),
    )
    while await app.state.push_worker.process_once():
        pass

    remaining = {c.id for c in await app.state.repo.list_push_clients_for_user(user.id)}
    assert remaining == {"and_1", "desk_1"}, "APNs 410 must clear only the iOS client's token"
    lengths = await app.state.redis_store.push_queue_lengths()
    assert lengths == {"ready": 0, "delayed": 0, "dead": 1}, "FCM permanent failure goes straight to dead letters"

    logged = "\n".join(capture_logs)
    for secret in (APNS_TOKEN, FCM_TOKEN, SECRET_BODY):
        assert secret not in logged


async def test_pipeline_retryable_failure_uses_backoff_and_retry_after(
    settings, db_engine, redis_client, router_pool, apns_config, capture_logs,
) -> None:
    throttled = httpx.Response(429, json={"reason": "TooManyRequests"}, headers={"retry-after": "30"})
    apns = ApnsScript([throttled, httpx.Response(503, json={"reason": "ServiceUnavailable"})])
    provider = PlatformPushProvider(apns=_apns_sender(apns_config, apns))
    app = _make_app(settings, db_engine, redis_client, router_pool, provider)
    worker = PushRetryWorker(
        app.state.redis_store,
        provider,
        token_store=app.state.repo,
        max_attempts=3,
        base_backoff_seconds=1.0,
    )
    _user, device = await _setup_user(app)
    await app.state.push_service.notify_from_device(
        authenticated_device_id=device.id,
        req=PushNotificationRequest(device_id=device.id, event_type="error", title="Fail"),
    )

    t0 = 1_900_000_000.0
    # ios (429 → retry after 30s), android + desktop fall back to the logging provider (FCM disabled).
    for _ in range(3):
        assert await worker.process_once(now_unix=t0) is True
    assert (await app.state.redis_store.push_queue_lengths())["delayed"] == 1
    assert await worker.process_once(now_unix=t0 + 29) is False, "Retry-After must override the 1s backoff"
    assert await worker.process_once(now_unix=t0 + 30) is True  # 503 → backoff 2s
    assert await worker.process_once(now_unix=t0 + 32) is True  # third attempt succeeds
    assert len(apns.requests) == 3
    assert await app.state.redis_store.push_queue_lengths() == {"ready": 0, "delayed": 0, "dead": 0}
    assert APNS_TOKEN not in "\n".join(capture_logs)


async def test_token_removal_skips_reregistered_token(app) -> None:
    user = await app.state.repo.create_user(email="rereg@example.com", password_hash="x", display_name="R")
    await app.state.device_service.register_client_push_token(
        user_id=user.id,
        req=RegisterClientPushRequest(client_id="ios_9", platform="ios", push_token="new-token"),
    )
    assert await app.state.repo.clear_client_push_token(client_id="ios_9", push_token="old-token") is False
    assert [c.push_token for c in await app.state.repo.list_push_clients_for_user(user.id)] == ["new-token"]
    assert await app.state.repo.clear_client_push_token(client_id="ios_9", push_token="new-token") is True
    assert await app.state.repo.list_push_clients_for_user(user.id) == []


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PUSH_ENV_VARS = (
    "AA_CONTROL_APNS_KEY_PATH",
    "AA_CONTROL_APNS_KEY",
    "AA_CONTROL_APNS_KEY_ID",
    "AA_CONTROL_APNS_TEAM_ID",
    "AA_CONTROL_APNS_BUNDLE_ID",
    "AA_CONTROL_APNS_ENVIRONMENT",
    "AA_CONTROL_FCM_CREDENTIALS_PATH",
    "AA_CONTROL_FCM_CREDENTIALS_JSON",
    "AA_CONTROL_FCM_PROJECT_ID",
)


@pytest.fixture
def clean_push_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    for name in PUSH_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    return monkeypatch


async def test_push_config_absent_keeps_logging_behaviour(
    clean_push_env, settings, db_engine, redis_client, router_pool,
) -> None:
    cfg = ControlSettings.from_env()
    assert cfg.push == PushConfig()
    provider = build_push_provider(cfg.push)
    assert provider.status() == {"apns": "disabled", "fcm": "disabled"}
    # No sender configured: delivery is logged and succeeds without any network call.
    await provider.send(_envelope(platform="ios"))
    await provider.send(_envelope(platform="android", token=FCM_TOKEN))
    await provider.close()

    app = create_app(
        settings=settings,
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        start_push_worker=False,
    )
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="https://aa.example.test") as client:
        resp = await client.get("/readyz")
    assert resp.json()["push"] == {"apns": "disabled", "fcm": "disabled"}


async def test_push_config_from_files(clean_push_env, tmp_path, ec_pem: str, rsa_pem: str) -> None:
    key_file = tmp_path / "AuthKey_KEY1234567.p8"
    key_file.write_text(ec_pem)
    sa_file = tmp_path / "service-account.json"
    sa_file.write_text(
        json.dumps(
            {
                "type": "service_account",
                "project_id": "aa-prod",
                "private_key_id": "kid-1",
                "private_key": rsa_pem,
                "client_email": "push@aa-prod.iam.gserviceaccount.com",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        )
    )
    clean_push_env.setenv("AA_CONTROL_APNS_KEY_PATH", str(key_file))
    clean_push_env.setenv("AA_CONTROL_APNS_KEY_ID", "KEY1234567")
    clean_push_env.setenv("AA_CONTROL_APNS_TEAM_ID", "TEAM123456")
    clean_push_env.setenv("AA_CONTROL_APNS_BUNDLE_ID", "dev.anywhere.agents")
    clean_push_env.setenv("AA_CONTROL_APNS_ENVIRONMENT", "sandbox")
    clean_push_env.setenv("AA_CONTROL_FCM_CREDENTIALS_PATH", str(sa_file))

    cfg = ControlSettings.from_env()
    assert cfg.push.apns is not None and cfg.push.apns.host == "https://api.sandbox.push.apple.com"
    assert cfg.push.fcm is not None and cfg.push.fcm.project_id == "aa-prod"
    assert cfg.push.fcm.private_key_id == "kid-1"
    # Credentials never show up in reprs (and therefore never in logged settings).
    assert "PRIVATE KEY" not in repr(cfg)
    assert "PRIVATE KEY" not in repr(cfg.push)

    provider = build_push_provider(cfg.push)
    assert provider.status() == {"apns": "configured", "fcm": "configured"}
    await provider.close()


async def test_push_config_inline_and_override(clean_push_env, ec_pem: str, rsa_pem: str) -> None:
    clean_push_env.setenv("AA_CONTROL_APNS_KEY", ec_pem.replace("\n", "\\n"))
    clean_push_env.setenv("AA_CONTROL_APNS_KEY_ID", "K")
    clean_push_env.setenv("AA_CONTROL_APNS_TEAM_ID", "T")
    clean_push_env.setenv("AA_CONTROL_APNS_BUNDLE_ID", "B")
    clean_push_env.setenv(
        "AA_CONTROL_FCM_CREDENTIALS_JSON",
        json.dumps({"type": "service_account", "project_id": "p1", "private_key": rsa_pem,
                    "client_email": "e@p1.iam.gserviceaccount.com"}),
    )
    clean_push_env.setenv("AA_CONTROL_FCM_PROJECT_ID", "p-override")
    cfg = ControlSettings.from_env()
    assert cfg.push.apns is not None and cfg.push.apns.environment == "production"
    assert cfg.push.apns.private_key_pem == ec_pem.strip()
    assert cfg.push.fcm is not None and cfg.push.fcm.project_id == "p-override"
    assert cfg.push.fcm.token_uri == "https://oauth2.googleapis.com/token"
    provider = build_push_provider(cfg.push)  # keys load
    await provider.close()


def test_push_config_partial_or_invalid_fails_fast(clean_push_env, tmp_path) -> None:
    clean_push_env.setenv("AA_CONTROL_APNS_KEY_ID", "K")
    with pytest.raises(ValueError, match="partially configured"):
        ControlSettings.from_env()

    clean_push_env.delenv("AA_CONTROL_APNS_KEY_ID")
    clean_push_env.setenv("AA_CONTROL_FCM_CREDENTIALS_PATH", str(tmp_path / "missing.json"))
    with pytest.raises(ValueError, match="could not be read"):
        ControlSettings.from_env()

    with pytest.raises(ValueError, match="service_account"):
        parse_fcm_service_account(json.dumps({"type": "authorized_user", "client_email": "x", "private_key": "y"}))
    with pytest.raises(ValueError, match="project id"):
        parse_fcm_service_account(json.dumps({"client_email": "x", "private_key": "y"}))
