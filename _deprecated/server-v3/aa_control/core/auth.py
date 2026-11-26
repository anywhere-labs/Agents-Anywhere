from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any


def hash_password(password: str, *, salt: str | None = None, iterations: int = 120_000) -> str:
    """Hash password with PBKDF2-HMAC-SHA256 in exact v2 format for seamless 3.0 migration."""
    salt = salt or secrets.token_urlsafe(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), iterations)
    return f"pbkdf2_sha256${salt}${_b64_bytes(digest)}"


def password_salt(stored: str) -> str | None:
    try:
        algorithm, salt, _expected = stored.split("$", 2)
    except ValueError:
        return None
    return salt if algorithm == "pbkdf2_sha256" and salt else None


def verify_password(password: str, stored: str, *, iterations: int = 120_000) -> bool:
    try:
        algorithm, salt, expected = stored.split("$", 2)
    except ValueError:
        return False
    if algorithm != "pbkdf2_sha256":
        return False
    actual = hash_password(password, salt=salt, iterations=iterations).split("$", 2)[2]
    return hmac.compare_digest(actual, expected)


def hash_secret_digest(raw_secret: str) -> str:
    """SHA-256 hex digest used for stored refresh tokens, device secrets, and MCP tokens."""
    return hashlib.sha256(raw_secret.encode("utf-8")).hexdigest()


def verify_secret_digest(raw_secret: str, expected_hex: str) -> bool:
    return hmac.compare_digest(hash_secret_digest(raw_secret), expected_hex)


def generate_opaque_token(prefix: str, nbytes: int = 32) -> str:
    return f"{prefix}{secrets.token_urlsafe(nbytes)}"


def create_access_token(
    *,
    secret_key: str,
    user_id: str,
    expires_in: int,
    token_type: str = "user",
    extra: dict[str, Any] | None = None,
) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    payload: dict[str, Any] = {
        "sub": user_id,
        "typ": token_type,
        "exp": int(time.time()) + expires_in,
    }
    if extra:
        payload.update(extra)
    signing_input = f"{_b64_json(header)}.{_b64_json(payload)}"
    sig = _b64_bytes(hmac.new(secret_key.encode("utf-8"), signing_input.encode("utf-8"), hashlib.sha256).digest())
    return f"{signing_input}.{sig}"


def verify_access_token(
    *,
    secret_key: str,
    token: str,
    expected_type: str = "user",
) -> dict[str, Any] | None:
    try:
        header_b64, payload_b64, sig = token.split(".", 2)
        expected = _b64_bytes(
            hmac.new(secret_key.encode("utf-8"), f"{header_b64}.{payload_b64}".encode(), hashlib.sha256).digest()
        )
        if not hmac.compare_digest(expected, sig):
            return None
        data = json.loads(_b64_decode(payload_b64).decode("utf-8"))
    except (ValueError, json.JSONDecodeError):
        return None
    if data.get("typ") != expected_type:
        return None
    if int(data.get("exp") or 0) < int(time.time()):
        return None
    if not isinstance(data.get("sub"), str) or not data["sub"]:
        return None
    return data


def verify_pkce_s256(code_verifier: str, code_challenge: str) -> bool:
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    computed = _b64_bytes(digest)
    return hmac.compare_digest(computed, code_challenge)


@dataclass(frozen=True)
class ClientPrincipal:
    user_id: str
    client_id: str

    def format(self) -> str:
        return f"user:{self.user_id}/client:{self.client_id}"


@dataclass(frozen=True)
class DevicePrincipal:
    device_id: str

    def format(self) -> str:
        return f"device:{self.device_id}"


def format_client_principal(user_id: str, client_id: str) -> str:
    return f"user:{user_id}/client:{client_id}"


def format_device_principal(device_id: str) -> str:
    return f"device:{device_id}"


def parse_client_principal(principal: str | None) -> ClientPrincipal | None:
    if not principal or not principal.startswith("user:"):
        return None
    parts = principal.split("/client:", 1)
    if len(parts) != 2:
        return None
    user_id = parts[0].removeprefix("user:")
    client_id = parts[1]
    if not user_id or not client_id:
        return None
    return ClientPrincipal(user_id=user_id, client_id=client_id)


def parse_device_principal(principal: str | None) -> DevicePrincipal | None:
    if not principal or not principal.startswith("device:"):
        return None
    device_id = principal.removeprefix("device:")
    if not device_id or "/" in device_id:
        return None
    return DevicePrincipal(device_id=device_id)


def _b64_json(value: dict[str, Any]) -> str:
    return _b64_bytes(json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8"))


def _b64_bytes(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)
