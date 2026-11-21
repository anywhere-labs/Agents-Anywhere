from __future__ import annotations

import json
import os
from dataclasses import dataclass, field


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
    """Optional external OAuth login provider configured via environment."""

    name: str
    authorize_url: str
    token_url: str
    userinfo_url: str
    client_id: str
    client_secret: str = field(repr=False)
    scopes: str = "openid email profile"
    label: str = "OAuth"


@dataclass(frozen=True)
class ControlSettings:
    database_url: str
    redis_url: str
    secret_key: str = field(repr=False)
    public_origin: str = "http://127.0.0.1:8080"
    routers: tuple[RouterEndpoint, ...] = ()
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
        registration_open = os.environ.get("AA_CONTROL_REGISTRATION_OPEN", "true").lower() in {
            "1",
            "true",
            "yes",
        }
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
