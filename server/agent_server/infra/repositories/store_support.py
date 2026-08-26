# ruff: noqa: F401, F811, I001

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import re
import secrets
import shutil
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from loguru import logger
from sqlalchemy import create_engine, delete, func, insert, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from agent_server.core.auth import (
    hash_password,
    password_salt,
    verify_password,
    verify_password_verifier,
)
from agent_server.infra.db import (
    app_releases as app_releases_t,
    build_engine,
    connector_protocol_capabilities as connector_protocol_capabilities_t,
    connector_runtime_catalogs as connector_runtime_catalogs_t,
    connector_terminal_roots as connector_terminal_roots_t,
    connectors as connectors_t,
    dashboard_daily_metrics as dashboard_daily_metrics_t,
    dashboard_settings as dashboard_settings_t,
    dashboard_user_daily_facts as dashboard_user_daily_facts_t,
    device_runtimes as device_runtimes_t,
    fs_preview_tokens as fs_preview_tokens_t,
    mobile_login_tokens as mobile_login_tokens_t,
    oauth_accounts as oauth_accounts_t,
    oauth_authorization_codes as oauth_authorization_codes_t,
    oauth_clients as oauth_clients_t,
    pairing_codes as pairing_codes_t,
    platform_user_activity as platform_user_activity_t,
    sessions as sessions_t,
    timeline_items as timeline_items_t,
    users as users_t,
)
from agent_server.infra.db.engine import SQLITE_BACKEND
from agent_server.infra.files import FileStorage, build_file_storage
from agent_server.core.models import (
    ConnectorConfigBundle,
    ConnectorView,
    OAuthClientView,
    PairingPollResponse,
    SessionRuntimeState,
    SessionView,
    UserView,
)
from agent_server.infra.repositories import (
    ActiveRunRepository,
    InstanceSettingsRepository,
)
from agent_server.services.attachments import AttachmentService
from agent_server.core.utc import utc_now
from agent_server.infra.timeline_store import SqlTimelineStore

DERIVED_SESSION_TITLE_MAX_CHARS = 48

# Username format: 3-32 chars, lowercase letters / digits / hyphen / underscore.
# Stored lowercase regardless of input.
USERNAME_RE = re.compile(r"^[a-z0-9_-]{3,32}$")

# instance_settings keys
SETTING_REGISTRATION_OPEN = "registration_open"
SETTING_OAUTH_REGISTRATION_OPEN = "oauth_registration_open"
SETTING_OAUTH_PROVIDER = "oauth_provider"

UserRole = str  # "admin" | "member"
ADMIN_ROLE = "admin"
MEMBER_ROLE = "member"


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _json_loads(value: str | None) -> Any:
    if not value:
        return None
    return json.loads(value)




def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _new_connector_token() -> str:
    return f"cxt_{secrets.token_urlsafe(32)}"


def _utc_now_plus(seconds: int) -> str:
    return (datetime.now(UTC) + timedelta(seconds=max(60, seconds))).isoformat().replace("+00:00", "Z")


def _default_files_root(engine: AsyncEngine, path: str | Path | None) -> Path:
    """Pick a sibling directory for uploaded file blobs.

    For sqlite we anchor to the database file; for other backends we fall back
    to a directory under the current working directory keyed by the database
    name component.
    """
    if path is not None:
        db_path = Path(str(path))
    else:
        url = engine.url
        if url.database and url.get_backend_name() == "sqlite":
            db_path = Path(url.database)
        else:
            db_path = Path(f"agent-server-{url.database or 'db'}.files-root")
    return db_path.with_suffix("").parent / f"{db_path.with_suffix('').name}.files"


def _user_from_row(row: Any) -> UserView:
    return UserView(
        userId=row["id"],
        role=row["role"],
        disabled=bool(row["disabled"]),
        avatar=row.get("avatar"),
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def _mobile_login_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _message_text(content: Any) -> str:
    if not isinstance(content, dict):
        return ""
    text = content.get("text")
    if not isinstance(text, str):
        return ""
    return " ".join(text.split())


def _truncate_title(text: str) -> str:
    if len(text) <= DERIVED_SESSION_TITLE_MAX_CHARS:
        return text
    return f"{text[:DERIVED_SESSION_TITLE_MAX_CHARS].rstrip()}..."


__all__ = [name for name in globals() if not name.startswith("__")]
