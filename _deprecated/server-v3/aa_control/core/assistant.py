from __future__ import annotations

import base64
import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from aa_control.core.errors import ValidationError

MIB = 1024 * 1024
DAY_SECONDS = 86_400

DEFAULT_MAX_CONVERSATION_BYTES = 20 * MIB
DEFAULT_MAX_CONVERSATIONS = 100
DEFAULT_MAX_ENCRYPTED_META_BYTES = 16 * 1024
DEFAULT_SSE_HEARTBEAT_SECONDS = 25.0
DEFAULT_TOKENS_URL = "https://tokens-anywhere.com"
DEFAULT_TOKENS_CLIENT_ID = "agents-anywhere"
DEFAULT_TOKENS_REFRESH_INTERVAL_SECONDS = 30 * DAY_SECONDS

CONVERSATION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
B64_RE = re.compile(r"^[A-Za-z0-9+/_-]+=*$")

ALLOWED_KDFS: frozenset[str] = frozenset({"pbkdf2-sha256", "argon2id"})
ALLOWED_WRAP_ALGS: frozenset[str] = frozenset({"AES-256-GCM"})

# Guardrail: clients must never send plaintext passphrases or raw keys inside envelope metadata.
FORBIDDEN_SECRET_KEYS: frozenset[str] = frozenset(
    {
        "password",
        "passphrase",
        "pin",
        "dek",
        "kek",
        "raw_key",
        "plaintext_dek",
        "plaintext_key",
        "secret",
        "private_key",
        "file_key",
    }
)


class TokensDecryptError(Exception):
    """Raised when a stored Tokens Anywhere secret cannot be decrypted (e.g. secret rotation)."""


@dataclass(frozen=True)
class ValidatedKeyEnvelopeInput:
    kdf: str
    kdf_params: dict[str, int | str]
    salt: str
    wrap_alg: str
    wrap_nonce: str | None
    wrapped_dek: str


def validate_conversation_id(conversation_id: str) -> str:
    if not CONVERSATION_ID_RE.match(conversation_id):
        raise ValidationError(
            "conversation_id must be 1-64 characters of [A-Za-z0-9_-]",
            code="invalid_conversation_id",
        )
    return conversation_id


def validate_b64_token(
    value: str,
    *,
    field_name: str,
    min_len: int,
    max_len: int,
) -> str:
    cleaned = value.strip()
    if len(cleaned) < min_len or len(cleaned) > max_len:
        raise ValidationError(
            f"{field_name} length must be between {min_len} and {max_len} characters"
        )
    if not B64_RE.match(cleaned):
        raise ValidationError(f"{field_name} must be valid base64 or base64url")
    return cleaned


def validate_kdf_params(kdf: str, params: Mapping[str, Any]) -> dict[str, int | str]:
    """Validate versioned KDF parameters while blocking unexpected or secret-like fields."""
    if kdf not in ALLOWED_KDFS:
        raise ValidationError(
            f"unsupported kdf {kdf!r}; allowed: {', '.join(sorted(ALLOWED_KDFS))}"
        )
    if not isinstance(params, Mapping):
        raise ValidationError("kdf_params must be a JSON object")

    for raw_key in params:
        if str(raw_key).strip().lower() in FORBIDDEN_SECRET_KEYS:
            raise ValidationError(f"forbidden secret field {raw_key!r} in kdf_params")

    cleaned: dict[str, int | str] = {}
    if kdf == "pbkdf2-sha256":
        allowed_keys = {"iterations", "hash", "dk_len"}
        extra = set(params.keys()) - allowed_keys
        if extra:
            raise ValidationError(f"unsupported pbkdf2-sha256 kdf_params keys: {', '.join(sorted(extra))}")
        iterations = params.get("iterations")
        if isinstance(iterations, bool) or not isinstance(iterations, int) or not (1 <= iterations <= 10_000_000):
            raise ValidationError("pbkdf2-sha256 requires integer iterations in [1, 10000000]")
        cleaned["iterations"] = iterations

        hash_alg = params.get("hash", "SHA-256")
        if hash_alg != "SHA-256":
            raise ValidationError("pbkdf2-sha256 hash parameter must be 'SHA-256'")
        cleaned["hash"] = "SHA-256"
    else:  # argon2id
        allowed_keys = {"memory_kib", "iterations", "parallelism", "dk_len"}
        extra = set(params.keys()) - allowed_keys
        if extra:
            raise ValidationError(f"unsupported argon2id kdf_params keys: {', '.join(sorted(extra))}")
        memory_kib = params.get("memory_kib")
        iterations = params.get("iterations")
        parallelism = params.get("parallelism")
        if isinstance(memory_kib, bool) or not isinstance(memory_kib, int) or not (1024 <= memory_kib <= 1_048_576):
            raise ValidationError("argon2id requires integer memory_kib in [1024, 1048576]")
        if isinstance(iterations, bool) or not isinstance(iterations, int) or not (1 <= iterations <= 100):
            raise ValidationError("argon2id requires integer iterations in [1, 100]")
        if isinstance(parallelism, bool) or not isinstance(parallelism, int) or not (1 <= parallelism <= 64):
            raise ValidationError("argon2id requires integer parallelism in [1, 64]")
        cleaned["memory_kib"] = memory_kib
        cleaned["iterations"] = iterations
        cleaned["parallelism"] = parallelism

    if "dk_len" in params:
        dk_len = params["dk_len"]
        if isinstance(dk_len, bool) or not isinstance(dk_len, int) or dk_len != 32:
            raise ValidationError("dk_len must be 32 (256-bit KEK)")
        cleaned["dk_len"] = 32

    return cleaned


def validate_key_envelope_input(
    *,
    kdf: str,
    kdf_params: Mapping[str, Any],
    salt: str,
    wrap_alg: str,
    wrap_nonce: str | None,
    wrapped_dek: str,
) -> ValidatedKeyEnvelopeInput:
    normalized_kdf = kdf.strip().lower()
    cleaned_params = validate_kdf_params(normalized_kdf, kdf_params)
    cleaned_salt = validate_b64_token(salt, field_name="salt", min_len=16, max_len=256)
    cleaned_wrap_alg = wrap_alg.strip()
    if cleaned_wrap_alg not in ALLOWED_WRAP_ALGS:
        raise ValidationError(
            f"unsupported wrap_alg {wrap_alg!r}; allowed: {', '.join(sorted(ALLOWED_WRAP_ALGS))}"
        )
    cleaned_nonce = (
        validate_b64_token(wrap_nonce, field_name="wrap_nonce", min_len=12, max_len=64)
        if wrap_nonce is not None
        else None
    )
    cleaned_wrapped = validate_b64_token(wrapped_dek, field_name="wrapped_dek", min_len=32, max_len=1024)
    return ValidatedKeyEnvelopeInput(
        kdf=normalized_kdf,
        kdf_params=cleaned_params,
        salt=cleaned_salt,
        wrap_alg=cleaned_wrap_alg,
        wrap_nonce=cleaned_nonce,
        wrapped_dek=cleaned_wrapped,
    )


def serialize_json_compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def measure_plaintext_conversation_size(
    *,
    messages_json: str,
    settings_json: str | None,
) -> int:
    total = len(messages_json.encode("utf-8"))
    if settings_json is not None:
        total += len(settings_json.encode("utf-8"))
    return total


def measure_encrypted_conversation_size(
    *,
    ciphertext: str,
    encrypted_meta: str | None,
) -> int:
    total = len(ciphertext.encode("utf-8"))
    if encrypted_meta is not None:
        total += len(encrypted_meta.encode("utf-8"))
    return total


# ---------------------------------------------------------------------------
# Tokens Anywhere managed key helpers
# ---------------------------------------------------------------------------


def derive_tokens_fernet(secret_key: str) -> Fernet:
    """Derive a domain-separated Fernet key from the control plane secret."""
    if not secret_key or not secret_key.strip():
        raise ValidationError("control plane secret_key must be configured to store Tokens connections")
    digest = hashlib.sha256(b"aa-v3-assistant-tokens:" + secret_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_tokens_secret(secret_key: str, plaintext: str) -> str:
    return derive_tokens_fernet(secret_key).encrypt(plaintext.encode("utf-8")).decode("ascii")


def decrypt_tokens_secret(secret_key: str, ciphertext: str) -> str:
    try:
        return derive_tokens_fernet(secret_key).decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except (InvalidToken, ValueError) as exc:
        raise TokensDecryptError("unable to decrypt stored Tokens Anywhere secret") from exc


def hash_tokens_key(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def tokens_key_prefix(key: str) -> str:
    return key[:11]


def validate_tokens_api_key(key: str) -> str:
    cleaned = key.strip()
    if len(cleaned) < 8 or len(cleaned) > 300 or not cleaned.startswith("sk-"):
        raise ValidationError("Tokens Anywhere managed key must start with 'sk-' and be 8-300 characters")
    return cleaned


def is_first_party_oidc_session(
    claims: Mapping[str, Any],
    *,
    allowed_client_ids: Sequence[str] = (),
) -> bool:
    """Determine whether verified OIDC claims represent the user's own first-party session.

    Third-party delegated OAuth apps or client-credentials machine tokens must NOT be allowed
    to read or manage the user's Tokens Anywhere managed API key.
    """
    gty = str(claims.get("gty") or claims.get("grant_type") or "").strip().lower()
    if gty in {"client-credentials", "client_credentials"}:
        return False
    token_kind = str(claims.get("token_kind") or claims.get("kind") or "").strip().lower()
    if token_kind in {"oauth", "mcp", "third_party"}:
        return False
    if claims.get("act") is not None:
        # RFC 8693 actor claim indicates a delegated third-party caller.
        return False

    allowed = {cid.strip() for cid in allowed_client_ids if cid and cid.strip()}
    if not allowed:
        return True

    presenter = claims.get("azp") or claims.get("client_id")
    if isinstance(presenter, str) and presenter.strip():
        return presenter.strip() in allowed

    # If the IdP omitted azp/client_id, fall back to checking aud intersection.
    aud = claims.get("aud")
    if isinstance(aud, str):
        return aud.strip() in allowed
    if isinstance(aud, list):
        return any(isinstance(item, str) and item.strip() in allowed for item in aud)
    return False
