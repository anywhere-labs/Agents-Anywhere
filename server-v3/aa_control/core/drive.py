from __future__ import annotations

import hashlib
import hmac
import posixpath
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote, urlencode, urlsplit

from aa_control.core.entitlements import (
    ENTITLEMENT_DRIVE_MAX_FILE_MB,
    ENTITLEMENT_DRIVE_QUOTA_MB,
    EntitlementSet,
)
from aa_control.core.errors import ValidationError

MIB = 1024 * 1024
DAY_SECONDS = 86_400
SHA256_HEX_RE = re.compile(r"^[0-9a-f]{64}$")
NONCE_B64_RE = re.compile(r"^[A-Za-z0-9+/_=-]{12,64}$")


@dataclass(frozen=True)
class DrivePolicyDefaults:
    quota_bytes: int = 512 * MIB
    max_file_bytes: int = 100 * MIB
    default_ttl_seconds: int = 7 * DAY_SECONDS
    max_ttl_seconds: int = 30 * DAY_SECONDS
    rpc_direct_max_bytes: int = 8 * MIB


@dataclass(frozen=True)
class DrivePolicyOverride:
    """Per-account override stored in ``drive_user_policies`` (None means inherit)."""

    quota_bytes: int | None = None
    max_file_bytes: int | None = None
    default_ttl_seconds: int | None = None
    max_ttl_seconds: int | None = None


@dataclass(frozen=True)
class ResolvedDrivePolicy:
    """Effective cloud-drive limits for one account after merging policy layers."""

    quota_bytes: int | None  # None means unlimited (< 0 override or entitlement)
    max_file_bytes: int | None
    default_ttl_seconds: int
    max_ttl_seconds: int
    rpc_direct_max_bytes: int
    source: str  # "account_override" | "entitlements" | "default"


def resolve_drive_policy(
    *,
    defaults: DrivePolicyDefaults,
    entitlements: Mapping[str, Any] | None = None,
    override: DrivePolicyOverride | None = None,
) -> ResolvedDrivePolicy:
    """Resolve effective drive quota/TTL limits: account override > entitlements > defaults."""
    ent = EntitlementSet.from_mapping(entitlements)
    used_override = False
    used_entitlement = False

    # 1. Total quota bytes (-1 => unlimited => None)
    if override is not None and override.quota_bytes is not None:
        quota_bytes = None if override.quota_bytes < 0 else override.quota_bytes
        used_override = True
    elif ent.is_unlimited(ENTITLEMENT_DRIVE_QUOTA_MB):
        quota_bytes = None
        used_entitlement = True
    elif (ent_quota_mb := ent.drive_quota_mb()) is not None:
        quota_bytes = ent_quota_mb * MIB
        used_entitlement = True
    else:
        quota_bytes = None if defaults.quota_bytes < 0 else defaults.quota_bytes

    # 2. Max single file size (-1 => unlimited => None)
    if override is not None and override.max_file_bytes is not None:
        max_file_bytes = None if override.max_file_bytes < 0 else override.max_file_bytes
        used_override = True
    elif ent.is_unlimited(ENTITLEMENT_DRIVE_MAX_FILE_MB):
        max_file_bytes = None
        used_entitlement = True
    elif (ent_max_file_mb := ent.drive_max_file_mb()) is not None:
        max_file_bytes = ent_max_file_mb * MIB
        used_entitlement = True
    else:
        max_file_bytes = None if defaults.max_file_bytes < 0 else defaults.max_file_bytes

    # 3. Default & max TTL seconds
    if override is not None and override.default_ttl_seconds is not None:
        default_ttl = max(60, override.default_ttl_seconds)
        used_override = True
    elif (ent_ttl_days := ent.drive_ttl_days()) is not None and ent_ttl_days > 0:
        default_ttl = ent_ttl_days * DAY_SECONDS
        used_entitlement = True
    else:
        default_ttl = max(60, defaults.default_ttl_seconds)

    if override is not None and override.max_ttl_seconds is not None:
        max_ttl = max(default_ttl, override.max_ttl_seconds)
        used_override = True
    else:
        max_ttl = max(default_ttl, defaults.max_ttl_seconds)

    source = "account_override" if used_override else ("entitlements" if used_entitlement else "default")
    return ResolvedDrivePolicy(
        quota_bytes=quota_bytes,
        max_file_bytes=max_file_bytes,
        default_ttl_seconds=default_ttl,
        max_ttl_seconds=max_ttl,
        rpc_direct_max_bytes=defaults.rpc_direct_max_bytes,
        source=source,
    )


def normalize_vfs_path(raw: str) -> str:
    """Validate and normalize a relative POSIX VFS path (rejecting traversal & NUL)."""
    if not raw or "\x00" in raw:
        raise ValidationError("invalid vfs_path")
    cleaned = raw.replace("\\", "/").strip().lstrip("/")
    if not cleaned:
        raise ValidationError("vfs_path must not be empty")
    parts = [segment for segment in cleaned.split("/") if segment]
    if not parts or any(segment in {".", ".."} for segment in parts):
        raise ValidationError("vfs_path must not contain '.' or '..' traversal segments")
    normalized = posixpath.normpath("/".join(parts))
    if normalized in {".", ".."} or normalized.startswith("../") or len(normalized) > 512:
        raise ValidationError("invalid vfs_path")
    return normalized


def sanitize_filename(raw: str | None) -> str | None:
    if raw is None:
        return None
    cleaned = raw.replace("\x00", "").replace("\\", "/").strip()
    if not cleaned:
        return None
    base = cleaned.rsplit("/", 1)[-1].strip()
    if not base or base in {".", ".."}:
        return None
    return base[:255]


# ---------------------------------------------------------------------------
# Pure AWS Signature Version 4 (S3-compatible) signing & presigning
# ---------------------------------------------------------------------------


def _hmac_sha256(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _sigv4_signing_key(secret_access_key: str, date_stamp: str, region: str, service: str = "s3") -> bytes:
    k_date = _hmac_sha256(f"AWS4{secret_access_key}".encode(), date_stamp)
    k_region = _hmac_sha256(k_date, region)
    k_service = _hmac_sha256(k_region, service)
    return _hmac_sha256(k_service, "aws4_request")


def _uri_encode_path(path: str) -> str:
    return quote(path, safe="/-_.~")


def _canonical_query(params: Mapping[str, str]) -> str:
    pairs = sorted((quote(str(k), safe="-_.~"), quote(str(v), safe="-_.~")) for k, v in params.items())
    return "&".join(f"{k}={v}" for k, v in pairs)


def build_s3_target(
    *,
    endpoint: str,
    bucket: str,
    object_key: str,
    path_style: bool = True,
) -> tuple[str, str, str]:
    """Return ``(scheme_and_netloc, host_header, canonical_uri)`` for an S3 object."""
    parsed = urlsplit(endpoint.rstrip("/"))
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError(f"invalid S3 endpoint URL: {endpoint!r}")
    key = object_key.lstrip("/")
    base_path = parsed.path.rstrip("/")
    if path_style:
        host = parsed.netloc
        raw_path = f"{base_path}/{bucket}/{key}"
    else:
        host = f"{bucket}.{parsed.netloc}"
        raw_path = f"{base_path}/{key}"
    canonical_uri = _uri_encode_path(raw_path)
    return f"{parsed.scheme}://{host}", host, canonical_uri


def presign_s3_url(
    *,
    method: str,
    endpoint: str,
    bucket: str,
    object_key: str,
    access_key_id: str,
    secret_access_key: str,
    region: str = "us-east-1",
    expires_seconds: int = 900,
    path_style: bool = True,
    signed_headers: Mapping[str, str] | None = None,
    extra_query_params: Mapping[str, str] | None = None,
    now: datetime | None = None,
) -> tuple[str, dict[str, str]]:
    """Generate an AWS SigV4 presigned S3 URL (returns ``(url, required_headers)``)."""
    ts = (now or datetime.now(UTC)).astimezone(UTC)
    amz_date = ts.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = ts.strftime("%Y%m%d")
    scope = f"{date_stamp}/{region}/s3/aws4_request"

    base_url, host, canonical_uri = build_s3_target(
        endpoint=endpoint,
        bucket=bucket,
        object_key=object_key,
        path_style=path_style,
    )

    headers_lower: dict[str, str] = {"host": host}
    caller_headers: dict[str, str] = {}
    for k, v in (signed_headers or {}).items():
        lk = k.strip().lower()
        val = " ".join(str(v).strip().split())
        if not lk or lk == "host":
            continue
        headers_lower[lk] = val
        caller_headers[k] = val

    sorted_header_names = sorted(headers_lower)
    signed_headers_str = ";".join(sorted_header_names)
    canonical_headers = "".join(f"{name}:{headers_lower[name]}\n" for name in sorted_header_names)

    query_params: dict[str, str] = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": f"{access_key_id}/{scope}",
        "X-Amz-Date": amz_date,
        "X-Amz-Expires": str(max(1, min(604_800, int(expires_seconds)))),
        "X-Amz-SignedHeaders": signed_headers_str,
    }
    for k, v in (extra_query_params or {}).items():
        query_params[str(k)] = str(v)

    canonical_qs = _canonical_query(query_params)
    canonical_request = "\n".join(
        [
            method.upper(),
            canonical_uri,
            canonical_qs,
            canonical_headers,
            signed_headers_str,
            "UNSIGNED-PAYLOAD",
        ]
    )
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signing_key = _sigv4_signing_key(secret_access_key, date_stamp, region, "s3")
    signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()

    final_qs = f"{canonical_qs}&{urlencode({'X-Amz-Signature': signature})}"
    return f"{base_url}{canonical_uri}?{final_qs}", caller_headers


def sign_s3_request_headers(
    *,
    method: str,
    endpoint: str,
    bucket: str,
    object_key: str,
    access_key_id: str,
    secret_access_key: str,
    region: str = "us-east-1",
    path_style: bool = True,
    payload: bytes = b"",
    extra_headers: Mapping[str, str] | None = None,
    now: datetime | None = None,
) -> tuple[str, dict[str, str]]:
    """Build URL and AWS SigV4 Authorization headers for backend S3 calls (HEAD/DELETE/PUT)."""
    ts = (now or datetime.now(UTC)).astimezone(UTC)
    amz_date = ts.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = ts.strftime("%Y%m%d")
    scope = f"{date_stamp}/{region}/s3/aws4_request"
    payload_hash = hashlib.sha256(payload).hexdigest()

    base_url, host, canonical_uri = build_s3_target(
        endpoint=endpoint,
        bucket=bucket,
        object_key=object_key,
        path_style=path_style,
    )

    headers_lower: dict[str, str] = {
        "host": host,
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    send_headers: dict[str, str] = {
        "x-amz-content-sha256": payload_hash,
        "x-amz-date": amz_date,
    }
    for k, v in (extra_headers or {}).items():
        lk = k.strip().lower()
        val = " ".join(str(v).strip().split())
        if not lk or lk == "host":
            continue
        headers_lower[lk] = val
        send_headers[k] = val

    sorted_header_names = sorted(headers_lower)
    signed_headers_str = ";".join(sorted_header_names)
    canonical_headers = "".join(f"{name}:{headers_lower[name]}\n" for name in sorted_header_names)
    canonical_request = "\n".join(
        [
            method.upper(),
            canonical_uri,
            "",
            canonical_headers,
            signed_headers_str,
            payload_hash,
        ]
    )
    string_to_sign = "\n".join(
        [
            "AWS4-HMAC-SHA256",
            amz_date,
            scope,
            hashlib.sha256(canonical_request.encode("utf-8")).hexdigest(),
        ]
    )
    signing_key = _sigv4_signing_key(secret_access_key, date_stamp, region, "s3")
    signature = hmac.new(signing_key, string_to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    send_headers["Authorization"] = (
        f"AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, "
        f"SignedHeaders={signed_headers_str}, Signature={signature}"
    )
    return f"{base_url}{canonical_uri}", send_headers
