from __future__ import annotations

import hashlib
import hmac
import posixpath
import re
import unicodedata
from collections.abc import Container, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote, urlencode, urlsplit

from aa_control.core.entitlements import (
    ENTITLEMENT_DRIVE_MAX_FILE_MB,
    ENTITLEMENT_DRIVE_QUOTA_MB,
    EntitlementSet,
)
from aa_control.core.errors import ConflictError, ValidationError

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
# Drive filesystem: absolute paths, folders and `drive:` text references
# ---------------------------------------------------------------------------
#
# Every drive file has a normalized absolute path such as ``/报告/2026/q3.pdf``; folders are explicit records and
# the root ``/`` is implicit. Two folders are created by the server itself and keep fixed English storage names:
# ``/Transfers`` (attachments relayed to work devices) and ``/Orches`` (the Orches assistant's cloud workspace,
# mirrored from each file's ``vfs_path`` and managed by Orches' own sync).

DRIVE_ROOT = "/"
TRANSFERS_FOLDER = "/Transfers"
ORCHES_FOLDER = "/Orches"
SYSTEM_FOLDERS: dict[str, str] = {TRANSFERS_FOLDER: "transfers", ORCHES_FOLDER: "orches"}
MAX_DRIVE_NAME_CHARS = 255
MAX_DRIVE_PATH_CHARS = 1024
MAX_DRIVE_DEPTH = 32
DRIVE_REF_PREFIX = "drive:"
DRIVE_CONFLICT_POLICIES = ("rename", "fail", "replace")

# Compound extensions kept together when a duplicate name gets its " (n)" suffix.
_COMPOUND_EXTENSIONS = (".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lz", ".tar.br")
# Characters percent-encoded in a canonical `drive:` reference (besides whitespace and control/format characters):
# `%` is the escape itself, `?` and `#` are reserved for later use, the rest commonly ends a reference in prose,
# Markdown links or tables.
# Full-width sentence punctuation too: Chinese text runs on right after it, so a reader ends a reference there.
_REF_ESCAPED = frozenset("%?#()[]<>\"'`|\\。，、；：！？")
_PERCENT_HEX = re.compile(r"%[0-9A-Fa-f]{2}")


def _invalid_path(message: str) -> ValidationError:
    return ValidationError(message, code="drive_invalid_path")


def _is_disallowed_char(ch: str) -> bool:
    """Control characters and lone surrogates never appear in a drive name."""
    return unicodedata.category(ch) in {"Cc", "Cs"}


def normalize_drive_name(raw: str) -> str:
    """Validate one path segment (a file or folder name); returns it NFC-normalized and trimmed."""
    name = unicodedata.normalize("NFC", raw).strip()
    if not name:
        raise _invalid_path("a name must not be empty")
    if "/" in name or "\\" in name:
        raise _invalid_path("a name must not contain '/' or '\\'")
    if name in {".", ".."}:
        raise _invalid_path("'.' and '..' are not valid names")
    if any(_is_disallowed_char(ch) for ch in name):
        raise _invalid_path("a name must not contain control characters")
    if len(name) > MAX_DRIVE_NAME_CHARS:
        raise _invalid_path(f"a name must be at most {MAX_DRIVE_NAME_CHARS} characters")
    return name


def normalize_drive_path(raw: str) -> str:
    """Normalize a drive path to its canonical absolute form.

    ``\\`` counts as ``/``, repeated and trailing slashes collapse, each name is NFC-normalized and trimmed, and a
    missing leading slash is added (``报告/q3.pdf`` → ``/报告/q3.pdf``). ``.`` / ``..`` segments, control
    characters, names over 255 characters, paths over 1024 characters or deeper than 32 levels are rejected.
    The empty string and ``/`` are the root.
    """
    text = raw.replace("\\", "/").strip()
    names: list[str] = []
    for segment in text.split("/"):
        if segment == "":
            continue
        names.append(normalize_drive_name(segment))
    if len(names) > MAX_DRIVE_DEPTH:
        raise _invalid_path(f"a path must be at most {MAX_DRIVE_DEPTH} levels deep")
    path = DRIVE_ROOT + "/".join(names)
    if len(path) > MAX_DRIVE_PATH_CHARS:
        raise _invalid_path(f"a path must be at most {MAX_DRIVE_PATH_CHARS} characters")
    return path


def drive_parent(path: str) -> str:
    """Parent folder of a normalized path (the root is its own parent)."""
    if path == DRIVE_ROOT:
        return DRIVE_ROOT
    head = path.rsplit("/", 1)[0]
    return head or DRIVE_ROOT


def drive_basename(path: str) -> str:
    """Last name of a normalized path ('' for the root)."""
    return path.rsplit("/", 1)[-1]


def join_drive_path(parent: str, name: str) -> str:
    return f"/{name}" if parent == DRIVE_ROOT else f"{parent}/{name}"


def is_within_drive_path(path: str, ancestor: str) -> bool:
    """True when ``path`` is ``ancestor`` itself or lies anywhere below it."""
    return ancestor == DRIVE_ROOT or path == ancestor or path.startswith(ancestor + "/")


def drive_ancestors(path: str) -> list[str]:
    """Folders between the root and ``path``, top-down, excluding both: ``/a/b/c`` → ``['/a', '/a/b']``."""
    names = [segment for segment in path.split("/") if segment]
    return ["/" + "/".join(names[:depth]) for depth in range(1, len(names))]


def system_folder_kind(path: str) -> str | None:
    """``"transfers"`` / ``"orches"`` for the two server-created folders, else ``None``."""
    return SYSTEM_FOLDERS.get(path)


def is_orches_path(path: str) -> bool:
    """Inside the Orches workspace (``/Orches`` and below), which only Orches' own sync writes to."""
    return path == ORCHES_FOLDER or path.startswith(ORCHES_FOLDER + "/")


def split_drive_name(name: str) -> tuple[str, str]:
    """Split a name into stem and extension: ``q3.pdf`` → (``q3``, ``.pdf``); ``.env`` has no extension."""
    lowered = name.lower()
    for ext in _COMPOUND_EXTENSIONS:
        if lowered.endswith(ext) and len(name) > len(ext):
            return name[: -len(ext)], name[-len(ext) :]
    dot = name.rfind(".")
    if dot <= 0:
        return name, ""
    return name[:dot], name[dot:]


def dedupe_drive_name(name: str, taken: Container[str], *, max_attempts: int = 10_000) -> str:
    """First free name among ``name``, ``name (1)``, ``name (2)``… (the suffix goes before the extension)."""
    if name not in taken:
        return name
    stem, ext = split_drive_name(name)
    if len(ext) > 32:
        stem, ext = name, ""
    for n in range(1, max_attempts + 1):
        suffix = f" ({n})"
        room = MAX_DRIVE_NAME_CHARS - len(suffix) - len(ext)
        candidate = f"{stem[:room].rstrip() or stem[:room]}{suffix}{ext}"
        if candidate not in taken:
            return candidate
    raise ConflictError(f"too many files named {name!r} in this folder", code="drive_path_conflict")


def safe_drive_name(raw: str | None, fallback: str) -> str:
    """A usable name derived from an uploaded file name (``fallback`` when there is none).

    Unlike :func:`normalize_drive_name` this never fails: it keeps the last path segment, replaces control
    characters with ``_`` and shortens long names while keeping the extension.
    """
    if raw is None:
        return fallback
    base = unicodedata.normalize("NFC", raw).replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = "".join("_" if _is_disallowed_char(ch) else ch for ch in base).strip()
    if not cleaned or cleaned in {".", ".."}:
        return fallback
    if len(cleaned) > MAX_DRIVE_NAME_CHARS:
        stem, ext = split_drive_name(cleaned)
        if len(ext) > 32:
            stem, ext = cleaned, ""
        cleaned = stem[: MAX_DRIVE_NAME_CHARS - len(ext)].rstrip() + ext
    return cleaned


def default_transfer_path(filename: str | None, file_id: str) -> str:
    """Where an upload without an explicit place lands: ``/Transfers/<name>`` (the file id when it has no name)."""
    return join_drive_path(TRANSFERS_FOLDER, safe_drive_name(filename, file_id))


def orches_drive_path(vfs_path: str | None, file_id: str) -> str:
    """Drive path of an Orches workspace file: ``/Orches/<vfs_path>``.

    ``vfs_path`` stays the authoritative name for Orches (its encryption binds to it); the drive path mirrors it.
    A file without a plaintext ``vfs_path`` (encrypted uploads may leave it out) or with one that is not a valid
    drive path lands at ``/Orches/<file id>``, so no name is revealed or invented.
    """
    if vfs_path:
        try:
            return normalize_drive_path(f"{ORCHES_FOLDER}/{vfs_path}")
        except ValidationError:
            pass
    return join_drive_path(ORCHES_FOLDER, file_id)


def _ref_needs_escape(ch: str) -> bool:
    if ch in _REF_ESCAPED:
        return True
    category = unicodedata.category(ch)
    return category[0] in {"Z", "C"}


def format_drive_ref(path: str) -> str:
    """Canonical text reference of a drive path: ``drive:/报告/2026/q3.pdf``.

    Names stay readable (non-ASCII letters are kept as they are); whitespace, control and format characters,
    ``%``, the reserved ``?`` / ``#`` and characters that usually end a reference in text (``()[]<>"'`|`` and the
    full-width ``。，、；：！？``) are percent-encoded as UTF-8, e.g. ``drive:/Transfers/q3%20%281%29.pdf``.
    """
    normalized = normalize_drive_path(path)
    out: list[str] = []
    for ch in normalized:
        if _ref_needs_escape(ch):
            out.append("".join(f"%{byte:02X}" for byte in ch.encode("utf-8")))
        else:
            out.append(ch)
    return DRIVE_REF_PREFIX + "".join(out)


def _percent_decode(text: str) -> str:
    """Decode ``%XX`` runs as UTF-8; a ``%`` that does not start an escape stays literal."""
    out: list[str] = []
    pending = bytearray()
    index = 0

    def flush() -> None:
        if pending:
            try:
                out.append(pending.decode("utf-8"))
            except UnicodeDecodeError as exc:
                raise ValidationError(
                    "a drive reference contains percent-escapes that are not UTF-8",
                    code="drive_invalid_ref",
                ) from exc
            pending.clear()

    while index < len(text):
        if text[index] == "%" and _PERCENT_HEX.match(text, index):
            pending.append(int(text[index + 1 : index + 3], 16))
            index += 3
            continue
        flush()
        out.append(text[index])
        index += 1
    flush()
    return "".join(out)


def parse_drive_ref(ref: str) -> str:
    """Parse a ``drive:/…`` reference into a normalized absolute drive path.

    The ``drive:`` scheme is case-insensitive and must be followed by an absolute path. Percent-escapes are
    decoded, so both ``drive:/a%20b.txt`` and the hand-written ``drive:/a b.txt`` resolve to ``/a b.txt``.
    ``drive://…`` is reserved (for example for cross-account references later), and so are unescaped ``?`` and
    ``#``: write them as ``%3F`` and ``%23``.
    """
    text = ref.strip()
    if text[: len(DRIVE_REF_PREFIX)].lower() != DRIVE_REF_PREFIX:
        raise ValidationError("a drive reference starts with 'drive:'", code="drive_invalid_ref")
    body = text[len(DRIVE_REF_PREFIX) :]
    if not body.startswith("/"):
        raise ValidationError(
            "a drive reference needs an absolute path, such as drive:/folder/file.pdf",
            code="drive_invalid_ref",
        )
    if body.startswith("//"):
        raise ValidationError("drive:// references are reserved", code="drive_invalid_ref")
    if "?" in body or "#" in body:
        raise ValidationError(
            "'?' and '#' are reserved in drive references; percent-encode them as %3F and %23",
            code="drive_invalid_ref",
        )
    try:
        return normalize_drive_path(_percent_decode(body))
    except ValidationError as exc:
        if exc.code == "drive_invalid_ref":
            raise
        raise ValidationError(f"invalid drive reference: {exc.message}", code="drive_invalid_ref") from exc


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
