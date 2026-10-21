# ruff: noqa: F401, F811, I001

from __future__ import annotations

import asyncio
import base64
import binascii
import functools
import hashlib
import inspect
import json
import re
import secrets
import shutil
from contextlib import asynccontextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from loguru import logger
from sqlalchemy import and_, create_engine, delete, func, insert, or_, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, create_async_engine

from agent_server.core.auth import (
    hash_password,
    password_salt,
    verify_password,
    verify_password_verifier,
)
from agent_server.infra.db import (
    build_engine,
    connector_protocol_capabilities as connector_protocol_capabilities_t,
    connector_runtime_catalogs as connector_runtime_catalogs_t,
    connector_runtime_types as connector_runtime_types_t,
    connector_terminal_roots as connector_terminal_roots_t,
    connectors as connectors_t,
    device_runtimes as device_runtimes_t,
    fs_preview_tokens as fs_preview_tokens_t,
    mobile_login_tokens as mobile_login_tokens_t,
    oauth_accounts as oauth_accounts_t,
    oauth_authorization_codes as oauth_authorization_codes_t,
    oauth_clients as oauth_clients_t,
    pairing_codes as pairing_codes_t,
    projects as projects_t,
    sessions as sessions_t,
    session_shares as session_shares_t,
    timeline_items as timeline_items_t,
    usage_events as usage_events_t,
    usage_inventory_snapshots as usage_inventory_snapshots_t,
    users as users_t,
)
from agent_server.infra.files import FileStorage, build_file_storage
from agent_server.core.models import (
    ConnectorConfigBundle,
    ConnectorKind,
    ConnectorView,
    OAuthClientView,
    PairingPollResponse,
    ProjectView,
    SessionRuntimeState,
    SessionView,
    UserView,
)
from agent_server.core.runtime_identity import RuntimeIdentity
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
SETTING_PASSWORD_RESET_ENABLED = "password_reset_enabled"

UserRole = str  # "admin" | "member"
ADMIN_ROLE = "admin"
MEMBER_ROLE = "member"


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _json_loads(value: str | None) -> Any:
    if not value:
        return None
    return json.loads(value)


def session_revision_fenced(method: Any) -> Any:
    """Run one single-session revision writer inside the bound coordinator.

    Repository mixins stay independent from the service implementation.  The
    app-scoped timeline buffer binds the actual context manager on ``Store``;
    tests and tools that construct a Store without a buffer keep the original
    direct database behavior.
    """

    signature = inspect.signature(method)

    @functools.wraps(method)
    async def wrapped(self: Any, *args: Any, **kwargs: Any) -> Any:
        arguments = signature.bind(self, *args, **kwargs).arguments
        session_id = arguments.get("session_id")
        if not isinstance(session_id, str) or not session_id:
            raise ValueError("session revision writer requires a session_id")
        async with self.session_revision_fence(session_id):
            try:
                previous = await self.get_session(session_id)
            except KeyError:
                previous = None
            result = await method(self, *args, **kwargs)
            if (
                previous is not None
                and isinstance(result, SessionView)
                and previous.updatedSeq == result.updatedSeq
                and previous.sortAt == result.sortAt
            ):
                return result
            await self.publish_session_revision_result(
                session_id,
                operation=method.__name__,
                result=result,
            )
            return result

    return wrapped




def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _new_connector_token() -> str:
    return f"cxt_{secrets.token_urlsafe(32)}"


def _utc_now_plus(seconds: int) -> str:
    return (datetime.now(UTC) + timedelta(seconds=max(60, seconds))).isoformat().replace("+00:00", "Z")


def _default_files_root(engine: AsyncEngine) -> Path:
    """Pick a directory for uploaded file blobs.

    Falls back to a directory under the current working directory keyed by the
    database name; deployments configure the file backend explicitly.
    """
    db_path = Path(f"agent-server-{engine.url.database or 'db'}.files-root")
    return db_path.with_suffix("").parent / f"{db_path.with_suffix('').name}.files"


def _user_from_row(row: Any) -> UserView:
    return UserView(
        userId=row["id"],
        email=row.get("email"),
        emailVerified=bool(row.get("email_verified_at")),
        displayName=row.get("display_name") or "",
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


def _client_session_title(title: str | None) -> str | None:
    # Web / Desktop send the whole first prompt as the create-time title.
    # Normalize it like a derived title so a pasted document never becomes a
    # multi-kilobyte session name (Codex never reports a replacement title).
    if title is None:
        return None
    collapsed = " ".join(title.split())
    return _truncate_title(collapsed) if collapsed else None


def _manual_archive_values(*, archived: bool | int, now: str) -> dict[str, Any]:
    """Column values for a user-initiated session archive or unarchive."""

    return {
        "archived": int(bool(archived)),
        "archived_at": now if archived else None,
        "dsh_archive_legacy": 0,
        "updated_at": now,
    }


__all__ = [name for name in globals() if not name.startswith("__")]
