from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any


DEFAULT_EXPIRES_IN = 900
DEFAULT_USER_EXPIRES_IN = 60 * 60 * 24 * 7


def _secret() -> bytes:
    value = os.environ.get("AGENT_SERVER_SECRET", "agent-server-dev-secret")
    return value.encode("utf-8")


def create_connector_access_token(connector_id: str, expires_in: int = DEFAULT_EXPIRES_IN) -> str:
    expires_at = int(time.time()) + expires_in
    payload = f"{connector_id}:{expires_at}"
    sig = hmac.new(_secret(), payload.encode("utf-8"), hashlib.sha256).digest()
    encoded_sig = base64.urlsafe_b64encode(sig).decode("ascii").rstrip("=")
    return f"{connector_id}.{expires_at}.{encoded_sig}"


def verify_connector_access_token(token: str) -> str | None:
    try:
        connector_id, expires_at_text, received_sig = token.split(".", 2)
        expires_at = int(expires_at_text)
    except ValueError:
        return None

    if expires_at < int(time.time()):
        return None

    payload = f"{connector_id}:{expires_at}"
    expected_sig = base64.urlsafe_b64encode(
        hmac.new(_secret(), payload.encode("utf-8"), hashlib.sha256).digest()
    ).decode("ascii").rstrip("=")
    if not hmac.compare_digest(expected_sig, received_sig):
        return None
    return connector_id


def hash_password(password: str, *, salt: str | None = None) -> str:
    salt = salt or secrets.token_urlsafe(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return f"pbkdf2_sha256${salt}${base64.urlsafe_b64encode(digest).decode('ascii').rstrip('=')}"


def password_salt(stored: str) -> str | None:
    try:
        algorithm, salt, _expected = stored.split("$", 2)
    except ValueError:
        return None
    return salt if algorithm == "pbkdf2_sha256" and salt else None


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, salt, expected = stored.split("$", 2)
    except ValueError:
        return False
    if algorithm != "pbkdf2_sha256":
        return False
    actual = hash_password(password, salt=salt).split("$", 2)[2]
    return hmac.compare_digest(actual, expected)


def verify_password_verifier(verifier: str, stored: str) -> bool:
    try:
        algorithm, _salt, expected = stored.split("$", 2)
    except ValueError:
        return False
    if algorithm != "pbkdf2_sha256":
        return False
    return hmac.compare_digest(verifier, expected)


def hash_password_verifier(verifier: str, *, salt: str) -> str:
    if not verifier:
        raise ValueError("password verifier is required")
    return f"pbkdf2_sha256${salt}${verifier}"


def create_user_access_token(user_id: str, expires_in: int = DEFAULT_USER_EXPIRES_IN) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    payload = {"sub": user_id, "exp": int(time.time()) + expires_in}
    signing_input = f"{_b64_json(header)}.{_b64_json(payload)}"
    signature = _b64_bytes(hmac.new(_secret(), signing_input.encode("utf-8"), hashlib.sha256).digest())
    return f"{signing_input}.{signature}"


def create_signed_token(kind: str, payload: dict[str, Any], expires_in: int) -> str:
    body = {"kind": kind, "exp": int(time.time()) + expires_in, **payload}
    signing_input = _b64_json(body)
    signature = _b64_bytes(hmac.new(_secret(), signing_input.encode("utf-8"), hashlib.sha256).digest())
    return f"{signing_input}.{signature}"


def verify_signed_token(kind: str, token: str) -> dict[str, Any] | None:
    try:
        body, signature = token.split(".", 1)
        expected = _b64_bytes(hmac.new(_secret(), body.encode("utf-8"), hashlib.sha256).digest())
        if not hmac.compare_digest(expected, signature):
            return None
        data = json.loads(_b64_decode(body).decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return None
    if data.get("kind") != kind:
        return None
    if int(data.get("exp") or 0) < int(time.time()):
        return None
    return data


def verify_user_access_token(token: str) -> str | None:
    try:
        header, payload, signature = token.split(".", 2)
        expected = _b64_bytes(hmac.new(_secret(), f"{header}.{payload}".encode("utf-8"), hashlib.sha256).digest())
        if not hmac.compare_digest(expected, signature):
            return None
        data = json.loads(_b64_decode(payload).decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return None
    if int(data.get("exp") or 0) < int(time.time()):
        return None
    subject = data.get("sub")
    return subject if isinstance(subject, str) and subject else None


def _b64_json(value: dict[str, Any]) -> str:
    return _b64_bytes(json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def _b64_bytes(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)
