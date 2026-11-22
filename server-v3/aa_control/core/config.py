from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Literal

from aa_control.core.drive import DAY_SECONDS, MIB, DrivePolicyDefaults
from aa_control.core.entitlements import EntitlementMap, sanitize_entitlements
from aa_control.core.oidc import ALLOWED_OIDC_ALGORITHMS, DEFAULT_OIDC_ALGORITHMS

AuthMode = Literal["local", "oidc"]


@dataclass(frozen=True)
class RouterEndpoint:
    """One MeshCall Router that hosts aa.v3.Control and device instances."""

    id: str
    url: str
    public_url: str
    username: str
    password: str = field(repr=False)


@dataclass(frozen=True)
class OAuthProviderConfig:
    """Optional external OAuth login provider configured via environment (local mode)."""

    name: str
    authorize_url: str
    token_url: str
    userinfo_url: str
    client_id: str
    client_secret: str = field(repr=False)
    scopes: str = "openid email profile"
    label: str = "OAuth"


@dataclass(frozen=True)
class OidcAuthConfig:
    """OIDC / JWKS verification config for ``auth_mode="oidc"`` (anywhere-auth or third-party OIDC)."""

    issuer: str
    audiences: tuple[str, ...] = ()
    client_id: str | None = None
    verify_audience: bool = True
    jwks_uri: str | None = None
    authorization_endpoint: str | None = None
    token_endpoint: str | None = None
    userinfo_endpoint: str | None = None
    end_session_endpoint: str | None = None
    scopes: str = "openid profile email offline_access entitlements"
    provider_label: str = "Agents Anywhere"
    algorithms: tuple[str, ...] = DEFAULT_OIDC_ALGORITHMS
    jwks_cache_ttl_seconds: int = 300
    jwks_min_refresh_interval_seconds: int = 10
    leeway_seconds: int = 30
    role_claim: str = "role"
    admin_roles: tuple[str, ...] = ("admin",)
    plan_claim: str = "plan"
    entitlements_claim: str = "entitlements"

    def __post_init__(self) -> None:
        cleaned_issuer = self.issuer.strip().rstrip("/")
        if not cleaned_issuer:
            raise ValueError("OIDC issuer must be non-empty when auth_mode='oidc'")
        object.__setattr__(self, "issuer", cleaned_issuer)

        cleaned_audiences = tuple(item.strip() for item in self.audiences if item.strip())
        object.__setattr__(self, "audiences", cleaned_audiences)

        cleaned_client_id = self.client_id.strip() if self.client_id and self.client_id.strip() else None
        object.__setattr__(self, "client_id", cleaned_client_id)

        if not self.algorithms:
            raise ValueError("OIDC algorithms must not be empty")
        invalid_algs = [alg for alg in self.algorithms if alg not in ALLOWED_OIDC_ALGORITHMS]
        if invalid_algs:
            raise ValueError(
                f"OIDC algorithms must be asymmetric ({', '.join(sorted(ALLOWED_OIDC_ALGORITHMS))}); "
                f"rejected: {', '.join(invalid_algs)}"
            )
        if self.verify_audience and not self.effective_audiences:
            raise ValueError(
                "AA_CONTROL_OIDC_AUDIENCE or AA_CONTROL_OIDC_CLIENT_ID must be set when "
                "auth_mode='oidc' and verify_audience=True"
            )
        if self.jwks_cache_ttl_seconds < 1:
            raise ValueError("jwks_cache_ttl_seconds must be >= 1")
        if self.jwks_min_refresh_interval_seconds < 0:
            raise ValueError("jwks_min_refresh_interval_seconds must be >= 0")
        if self.leeway_seconds < 0:
            raise ValueError("leeway_seconds must be >= 0")

    @property
    def effective_audiences(self) -> tuple[str, ...]:
        if self.audiences:
            return self.audiences
        if self.client_id:
            return (self.client_id,)
        return ()

    @property
    def discovery_url(self) -> str:
        return f"{self.issuer}/.well-known/openid-configuration"


@dataclass(frozen=True)
class S3ObjectStoreConfig:
    """S3-compatible object storage configuration for cloud drive presigned transfers."""

    endpoint: str
    bucket: str
    access_key_id: str
    secret_access_key: str = field(repr=False)
    region: str = "us-east-1"
    public_endpoint: str | None = None
    path_style: bool = True
    key_prefix: str = "aa-drive"

    def __post_init__(self) -> None:
        if not self.endpoint.strip():
            raise ValueError("S3 endpoint must be non-empty")
        if not self.bucket.strip():
            raise ValueError("S3 bucket must be non-empty")
        if not self.access_key_id.strip() or not self.secret_access_key.strip():
            raise ValueError("S3 access_key_id and secret_access_key must be non-empty")
        object.__setattr__(self, "endpoint", self.endpoint.strip().rstrip("/"))
        if self.public_endpoint is not None:
            cleaned_pub = self.public_endpoint.strip().rstrip("/") or None
            object.__setattr__(self, "public_endpoint", cleaned_pub)
        object.__setattr__(self, "key_prefix", self.key_prefix.strip().strip("/"))

    @property
    def presign_endpoint(self) -> str:
        return self.public_endpoint or self.endpoint


@dataclass(frozen=True)
class DriveConfig:
    """Quota-limited cloud drive & large-file relay defaults."""

    default_quota_bytes: int = 512 * MIB
    default_max_file_bytes: int = 100 * MIB
    default_ttl_seconds: int = 7 * DAY_SECONDS
    max_ttl_seconds: int = 30 * DAY_SECONDS
    rpc_direct_max_bytes: int = 8 * MIB
    upload_url_ttl_seconds: int = 900
    download_url_ttl_seconds: int = 300
    cleanup_interval_seconds: float = 300.0
    s3: S3ObjectStoreConfig | None = None

    def policy_defaults(self) -> DrivePolicyDefaults:
        return DrivePolicyDefaults(
            quota_bytes=self.default_quota_bytes,
            max_file_bytes=self.default_max_file_bytes,
            default_ttl_seconds=self.default_ttl_seconds,
            max_ttl_seconds=self.max_ttl_seconds,
            rpc_direct_max_bytes=self.rpc_direct_max_bytes,
        )


@dataclass(frozen=True)
class ControlSettings:
    database_url: str
    redis_url: str
    secret_key: str = field(repr=False)
    public_origin: str = "http://127.0.0.1:8080"
    routers: tuple[RouterEndpoint, ...] = ()
    auth_mode: AuthMode = "local"
    oidc_auth: OidcAuthConfig | None = None
    default_entitlements: EntitlementMap = field(default_factory=dict)
    drive: DriveConfig = field(default_factory=DriveConfig)
    registration_open: bool = True
    bootstrap_setup_token: str | None = field(default=None, repr=False)
    access_token_ttl_seconds: int = 3600
    refresh_token_ttl_seconds: int = 60 * 60 * 24 * 30
    client_router_token_ttl_seconds: int = 4 * 3600
    device_router_token_ttl_seconds: int = 7 * 24 * 3600
    tunnel_ttl_seconds: int = 4 * 3600
    presence_ttl_seconds: int = 45
    fanout_timeout_seconds: float = 3.0
    token_issue_rate_limit_per_min: int = 60
    tunnel_open_rate_limit_per_min: int = 120
    push_max_attempts: int = 5
    push_base_backoff_seconds: float = 5.0
    mcp_access_token_ttl_seconds: int = 3600
    mcp_auth_code_ttl_seconds: int = 300
    password_iterations: int = 120_000
    cors_origins: tuple[str, ...] = ("*",)
    oauth_provider: OAuthProviderConfig | None = None

    def __post_init__(self) -> None:
        if self.auth_mode not in ("local", "oidc"):
            raise ValueError(f"unsupported auth_mode: {self.auth_mode!r} (expected 'local' or 'oidc')")
        if self.auth_mode == "oidc" and self.oidc_auth is None:
            raise ValueError("oidc_auth configuration is required when auth_mode='oidc'")
        object.__setattr__(self, "default_entitlements", sanitize_entitlements(self.default_entitlements))

    @classmethod
    def from_env(cls) -> ControlSettings:
        db_url = os.environ.get(
            "AA_CONTROL_DB_URL",
            os.environ.get(
                "AGENT_SERVER_DB_URL",
                "postgresql+asyncpg://agents_anywhere:agents_anywhere_dev_password@127.0.0.1:55432/agents_anywhere",
            ),
        )
        redis_url = os.environ.get(
            "AA_CONTROL_REDIS_URL",
            os.environ.get("AGENT_SERVER_REDIS_URL", "redis://127.0.0.1:56379/0"),
        )
        secret_key = os.environ.get(
            "AA_CONTROL_SECRET",
            os.environ.get("AGENT_SERVER_SECRET", "aa-control-dev-secret"),
        )
        public_origin = os.environ.get("AA_CONTROL_PUBLIC_ORIGIN", "http://127.0.0.1:8080").rstrip("/")
        routers = _parse_routers_env()
        raw_auth_mode = os.environ.get("AA_CONTROL_AUTH_MODE", "local").strip().lower()
        if raw_auth_mode not in ("local", "oidc"):
            raise ValueError(f"AA_CONTROL_AUTH_MODE must be 'local' or 'oidc', got {raw_auth_mode!r}")
        auth_mode: AuthMode = raw_auth_mode  # type: ignore[assignment]
        oidc_auth = _parse_oidc_auth_env(required=auth_mode == "oidc")
        default_entitlements = _parse_default_entitlements_env()
        drive = _parse_drive_env()
        registration_open = _env_bool("AA_CONTROL_REGISTRATION_OPEN", default=True)
        password_iterations = int(
            os.environ.get(
                "AA_CONTROL_PASSWORD_ITERATIONS",
                os.environ.get("AGENT_SERVER_PASSWORD_ITERATIONS", "120000"),
            )
        )
        cors_raw = os.environ.get("AA_CONTROL_CORS_ORIGINS", "*")
        cors_origins = tuple(item.strip() for item in cors_raw.split(",") if item.strip()) or ("*",)
        oauth_provider = _parse_oauth_provider_env()
        return cls(
            database_url=db_url,
            redis_url=redis_url,
            secret_key=secret_key,
            public_origin=public_origin,
            routers=routers,
            auth_mode=auth_mode,
            oidc_auth=oidc_auth,
            default_entitlements=default_entitlements,
            drive=drive,
            registration_open=registration_open,
            bootstrap_setup_token=os.environ.get("AA_CONTROL_SETUP_TOKEN") or None,
            access_token_ttl_seconds=int(os.environ.get("AA_CONTROL_ACCESS_TOKEN_TTL", "3600")),
            refresh_token_ttl_seconds=int(os.environ.get("AA_CONTROL_REFRESH_TOKEN_TTL", str(60 * 60 * 24 * 30))),
            client_router_token_ttl_seconds=int(os.environ.get("AA_CONTROL_CLIENT_ROUTER_TOKEN_TTL", str(4 * 3600))),
            device_router_token_ttl_seconds=int(os.environ.get("AA_CONTROL_DEVICE_ROUTER_TOKEN_TTL", str(7 * 24 * 3600))),
            tunnel_ttl_seconds=int(os.environ.get("AA_CONTROL_TUNNEL_TTL", str(4 * 3600))),
            presence_ttl_seconds=int(os.environ.get("AA_CONTROL_PRESENCE_TTL", "45")),
            fanout_timeout_seconds=float(os.environ.get("AA_CONTROL_FANOUT_TIMEOUT", "3.0")),
            token_issue_rate_limit_per_min=int(os.environ.get("AA_CONTROL_TOKEN_RATE_LIMIT", "60")),
            tunnel_open_rate_limit_per_min=int(os.environ.get("AA_CONTROL_TUNNEL_RATE_LIMIT", "120")),
            password_iterations=password_iterations,
            cors_origins=cors_origins,
            oauth_provider=oauth_provider,
        )


def _env_bool(name: str, *, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_csv(name: str) -> tuple[str, ...]:
    raw = os.environ.get(name, "")
    return tuple(item.strip() for item in raw.split(",") if item.strip())


def _parse_default_entitlements_env() -> EntitlementMap:
    raw = os.environ.get("AA_CONTROL_DEFAULT_ENTITLEMENTS_JSON", "").strip()
    if not raw:
        return {}
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise ValueError("AA_CONTROL_DEFAULT_ENTITLEMENTS_JSON must be a JSON object")
    return sanitize_entitlements(parsed)


def _parse_drive_env() -> DriveConfig:
    quota_mb = int(os.environ.get("AA_CONTROL_DRIVE_DEFAULT_QUOTA_MB", "512"))
    max_file_mb = int(os.environ.get("AA_CONTROL_DRIVE_MAX_FILE_MB", "100"))
    ttl_days = int(os.environ.get("AA_CONTROL_DRIVE_DEFAULT_TTL_DAYS", "7"))
    max_ttl_days = int(os.environ.get("AA_CONTROL_DRIVE_MAX_TTL_DAYS", "30"))
    rpc_max_bytes = int(os.environ.get("AA_CONTROL_DRIVE_RPC_MAX_BYTES", str(8 * MIB)))

    s3: S3ObjectStoreConfig | None = None
    endpoint = os.environ.get("AA_CONTROL_S3_ENDPOINT", "").strip()
    bucket = os.environ.get("AA_CONTROL_S3_BUCKET", "").strip()
    if endpoint and bucket:
        s3 = S3ObjectStoreConfig(
            endpoint=endpoint,
            bucket=bucket,
            access_key_id=os.environ.get("AA_CONTROL_S3_ACCESS_KEY_ID", ""),
            secret_access_key=os.environ.get("AA_CONTROL_S3_SECRET_ACCESS_KEY", ""),
            region=os.environ.get("AA_CONTROL_S3_REGION", "us-east-1"),
            public_endpoint=os.environ.get("AA_CONTROL_S3_PUBLIC_ENDPOINT") or None,
            path_style=_env_bool("AA_CONTROL_S3_PATH_STYLE", default=True),
            key_prefix=os.environ.get("AA_CONTROL_S3_KEY_PREFIX", "aa-drive"),
        )

    return DriveConfig(
        default_quota_bytes=-1 if quota_mb < 0 else quota_mb * MIB,
        default_max_file_bytes=-1 if max_file_mb < 0 else max_file_mb * MIB,
        default_ttl_seconds=max(60, ttl_days * DAY_SECONDS),
        max_ttl_seconds=max(60, max_ttl_days * DAY_SECONDS),
        rpc_direct_max_bytes=max(1024, rpc_max_bytes),
        upload_url_ttl_seconds=max(60, int(os.environ.get("AA_CONTROL_DRIVE_UPLOAD_URL_TTL", "900"))),
        download_url_ttl_seconds=max(30, int(os.environ.get("AA_CONTROL_DRIVE_DOWNLOAD_URL_TTL", "300"))),
        cleanup_interval_seconds=max(5.0, float(os.environ.get("AA_CONTROL_DRIVE_CLEANUP_INTERVAL", "300"))),
        s3=s3,
    )


def _parse_oidc_auth_env(*, required: bool) -> OidcAuthConfig | None:
    issuer = os.environ.get("AA_CONTROL_OIDC_ISSUER", "").strip()
    if not issuer:
        if required:
            raise ValueError("AA_CONTROL_OIDC_ISSUER is required when AA_CONTROL_AUTH_MODE=oidc")
        return None
    algorithms = _env_csv("AA_CONTROL_OIDC_ALGORITHMS") or DEFAULT_OIDC_ALGORITHMS
    admin_roles = _env_csv("AA_CONTROL_OIDC_ADMIN_ROLES") or ("admin",)
    return OidcAuthConfig(
        issuer=issuer,
        audiences=_env_csv("AA_CONTROL_OIDC_AUDIENCE"),
        client_id=os.environ.get("AA_CONTROL_OIDC_CLIENT_ID") or None,
        verify_audience=_env_bool("AA_CONTROL_OIDC_VERIFY_AUDIENCE", default=True),
        jwks_uri=os.environ.get("AA_CONTROL_OIDC_JWKS_URI") or None,
        authorization_endpoint=os.environ.get("AA_CONTROL_OIDC_AUTHORIZE_URL") or None,
        token_endpoint=os.environ.get("AA_CONTROL_OIDC_TOKEN_URL") or None,
        userinfo_endpoint=os.environ.get("AA_CONTROL_OIDC_USERINFO_URL") or None,
        end_session_endpoint=os.environ.get("AA_CONTROL_OIDC_END_SESSION_URL") or None,
        scopes=os.environ.get("AA_CONTROL_OIDC_SCOPES", "openid profile email offline_access entitlements"),
        provider_label=os.environ.get("AA_CONTROL_OIDC_LABEL", "Agents Anywhere"),
        algorithms=algorithms,
        jwks_cache_ttl_seconds=int(os.environ.get("AA_CONTROL_OIDC_JWKS_TTL", "300")),
        jwks_min_refresh_interval_seconds=int(os.environ.get("AA_CONTROL_OIDC_JWKS_MIN_REFRESH", "10")),
        leeway_seconds=int(os.environ.get("AA_CONTROL_OIDC_LEEWAY", "30")),
        role_claim=os.environ.get("AA_CONTROL_OIDC_ROLE_CLAIM", "role"),
        admin_roles=admin_roles,
        plan_claim=os.environ.get("AA_CONTROL_OIDC_PLAN_CLAIM", "plan"),
        entitlements_claim=os.environ.get("AA_CONTROL_OIDC_ENTITLEMENTS_CLAIM", "entitlements"),
    )


def _parse_routers_env() -> tuple[RouterEndpoint, ...]:
    raw_json = os.environ.get("AA_CONTROL_ROUTERS_JSON")
    if raw_json:
        items = json.loads(raw_json)
        return tuple(
            RouterEndpoint(
                id=str(item["id"]),
                url=str(item["url"]),
                public_url=str(item.get("public_url") or item["url"]),
                username=str(item["username"]),
                password=str(item["password"]),
            )
            for item in items
        )
    url = os.environ.get("AA_CONTROL_ROUTER_URL")
    if not url:
        return ()
    return (
        RouterEndpoint(
            id=os.environ.get("AA_CONTROL_ROUTER_ID", "router-1"),
            url=url,
            public_url=os.environ.get("AA_CONTROL_ROUTER_PUBLIC_URL", url),
            username=os.environ.get("AA_CONTROL_ROUTER_USERNAME", "control"),
            password=os.environ.get("AA_CONTROL_ROUTER_PASSWORD", "control-dev-password"),
        ),
    )


def _parse_oauth_provider_env() -> OAuthProviderConfig | None:
    client_id = os.environ.get("AA_CONTROL_OAUTH_CLIENT_ID")
    authorize_url = os.environ.get("AA_CONTROL_OAUTH_AUTHORIZE_URL")
    token_url = os.environ.get("AA_CONTROL_OAUTH_TOKEN_URL")
    userinfo_url = os.environ.get("AA_CONTROL_OAUTH_USERINFO_URL")
    if not (client_id and authorize_url and token_url and userinfo_url):
        return None
    return OAuthProviderConfig(
        name=os.environ.get("AA_CONTROL_OAUTH_PROVIDER_NAME", "oidc"),
        authorize_url=authorize_url,
        token_url=token_url,
        userinfo_url=userinfo_url,
        client_id=client_id,
        client_secret=os.environ.get("AA_CONTROL_OAUTH_CLIENT_SECRET", ""),
        scopes=os.environ.get("AA_CONTROL_OAUTH_SCOPES", "openid email profile"),
        label=os.environ.get("AA_CONTROL_OAUTH_LABEL", "OAuth"),
    )
