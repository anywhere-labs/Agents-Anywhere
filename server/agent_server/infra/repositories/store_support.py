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
from typing import Any, AsyncIterator

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
    agent_efforts as agent_efforts_t,
    agent_modes as agent_modes_t,
    agent_models as agent_models_t,
    approvals as approvals_t,
    build_engine,
    connectors as connectors_t,
    device_agent_settings as device_agent_settings_t,
    init_db,
    mobile_login_tokens as mobile_login_tokens_t,
    oauth_accounts as oauth_accounts_t,
    oauth_authorization_codes as oauth_authorization_codes_t,
    oauth_clients as oauth_clients_t,
    pairing_codes as pairing_codes_t,
    sessions as sessions_t,
    timeline_items as timeline_items_t,
    user_agent_defaults as user_agent_defaults_t,
    users as users_t,
)
from agent_server.infra.db.engine import (
    SQLITE_BACKEND,
    init_db_sync,
)
from agent_server.infra.files import FileStorage, build_file_storage
from agent_server.core.models import (
    AgentCatalogEntry,
    Approval,
    ApprovalIn,
    ConnectorConfigBundle,
    ConnectorView,
    OAuthClientView,
    PairingPollResponse,
    SessionView,
    TimelineItem,
    TimelineItemIn,
    UserView,
)
from agent_server.infra.repositories import (
    ActiveRunRepository,
    InstanceSettingsRepository,
    RuntimeSettingsRepository,
)
from agent_server.core.runtime_config import RuntimeConfigSchema
from agent_server.services.attachments import AttachmentService
from agent_server.services.runtime_config import RuntimeConfigService, seed_runtime_config_schemas_sync
from agent_server.core.utc import utc_now
from agent_server.infra.timeline_store import SqlTimelineStore

DERIVED_SESSION_TITLE_MAX_CHARS = 48

# Username format: 3-32 chars, lowercase letters / digits / hyphen / underscore.
# Stored lowercase regardless of input.
USERNAME_RE = re.compile(r"^[a-z0-9_-]{3,32}$")

# instance_settings keys
SETTING_REGISTRATION_OPEN = "registration_open"
SETTING_OAUTH_REGISTRATION_OPEN = "oauth_registration_open"


SUPPORTED_DEFAULT_AGENT_RUNTIMES = ("codex", "claude")


def default_agent_settings(runtime: str) -> dict[str, Any]:
    if runtime == "codex":
        return {
            "permissionMode": "ask",
            "model": None,
            "effort": None,
        }
    if runtime == "claude":
        return {
            "runMode": "chat",
            "permissionMode": "acceptEdits",
            "model": None,
            "effort": None,
        }
    raise ValueError(f"unsupported runtime: {runtime}")
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


def _default_agents_state_v3() -> dict[str, Any]:
    return {
        "version": 3,
        "lastDiscoveredAt": None,
        "defaultsAppliedAt": None,
        "observed": {},
        "desired": {},
    }


def _desired_is_enabled(intent: Any) -> bool:
    return isinstance(intent, dict) and intent.get("enabled") is True


def _normalize_agents_blob(raw: Any) -> dict[str, Any]:
    """Coerce whatever was on disk into the internal DeviceAgentsState v3.

    v3 separates two durable facts:
      - observed: what the connector discovered on the machine
      - desired: what the user wants enabled on this device

    Older v1/v2 blobs are translated on read. Callers that serve the current
    frontend should pass the v3 state through `_agents_view_from_state`.
    """
    if not isinstance(raw, dict):
        return _default_agents_state_v3()
    if raw.get("version") == 3:
        return {
            "version": 3,
            "lastDiscoveredAt": raw.get("lastDiscoveredAt"),
            "defaultsAppliedAt": raw.get("defaultsAppliedAt"),
            "observed": dict(raw.get("observed") or {}),
            "desired": dict(raw.get("desired") or {}),
        }

    if raw.get("version") == 2:
        observed: dict[str, Any] = {}
        desired: dict[str, Any] = {}
        for runtime, attached in dict(raw.get("attached") or {}).items():
            if not isinstance(attached, dict):
                continue
            report = attached.get("report")
            attached_at = attached.get("attachedAt") or raw.get("lastDiscoveredAt") or utc_now()
            if isinstance(report, dict):
                observed[runtime] = {"report": report, "observedAt": raw.get("lastDiscoveredAt")}
            desired[runtime] = {"enabled": True, "updatedAt": attached_at}
        for runtime in list(raw.get("disabled") or []):
            desired[str(runtime)] = {"enabled": False, "updatedAt": raw.get("lastDiscoveredAt")}
        return {
            "version": 3,
            "lastDiscoveredAt": raw.get("lastDiscoveredAt"),
            "defaultsAppliedAt": raw.get("lastDiscoveredAt"),
            "observed": observed,
            "desired": desired,
        }

    legacy_runtimes = raw.get("runtimes")
    observed: dict[str, Any] = {}
    desired: dict[str, Any] = {}
    observed_at = raw.get("checkedAt")
    if isinstance(legacy_runtimes, dict):
        for runtime, report in legacy_runtimes.items():
            if not isinstance(report, dict):
                continue
            observed[runtime] = {"report": report, "observedAt": observed_at}
            if report_is_attachable(report):
                desired[runtime] = {"enabled": True, "updatedAt": observed_at or utc_now()}
    return {
        "version": 3,
        "lastDiscoveredAt": observed_at,
        "defaultsAppliedAt": observed_at,
        "observed": observed,
        "desired": desired,
    }


def _agents_view_from_state(state: dict[str, Any]) -> dict[str, Any]:
    """Return the frontend-compatible attached/disabled view for a v3 state."""
    normalized = _normalize_agents_blob(state)
    observed = normalized.get("observed") or {}
    desired = normalized.get("desired") or {}
    attached: dict[str, Any] = {}
    disabled: list[str] = []
    for runtime, intent in desired.items():
        if _desired_is_enabled(intent):
            observation = observed.get(runtime)
            report = observation.get("report") if isinstance(observation, dict) else None
            if isinstance(report, dict):
                attached[runtime] = {
                    "report": report,
                    "attachedAt": intent.get("updatedAt") or observation.get("observedAt") or utc_now(),
                }
        elif isinstance(intent, dict) and intent.get("enabled") is False:
            disabled.append(runtime)
    return {
        "version": 3,
        "lastDiscoveredAt": normalized.get("lastDiscoveredAt"),
        "attached": attached,
        "disabled": sorted(disabled),
    }


def _active_runtimes_from_state(state: dict[str, Any]) -> list[str]:
    """Compute the connector execution set from observed facts + desired intent."""
    normalized = _normalize_agents_blob(state)
    observed = normalized.get("observed") or {}
    desired = normalized.get("desired") or {}
    active: list[str] = []
    for runtime, intent in desired.items():
        if not _desired_is_enabled(intent):
            continue
        observation = observed.get(runtime)
        report = observation.get("report") if isinstance(observation, dict) else None
        if isinstance(report, dict) and report.get("execution") in {"ok", "ok_empty"}:
            active.append(runtime)
    return sorted(active)


def report_is_attachable(report: Any) -> bool:
    """Pure-function domain rule: should a runtime with this report be
    surfaced as an attached agent? (Public so routers can consult it.)

    Mirror of the frontend's pre-refactor `isRuntimeAttached`: a runtime
    is worth surfacing if the daemon either found a usable binary
    (`selected` present) or at least found one candidate that failed a
    check (we want to show a warning row for "I have codex but it's
    broken"). All-missing reports get hidden — the user doesn't have it.

    Used on first-pair auto-enable + legacy migration.
    """
    if not isinstance(report, dict):
        return False
    if report.get("selected"):
        return True
    checked = report.get("checked")
    if isinstance(checked, list):
        return any(
            isinstance(c, dict) and c.get("status") == "failed" for c in checked
        )
    return False


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _new_connector_token() -> str:
    return f"cxt_{secrets.token_urlsafe(32)}"


def _utc_now_plus(seconds: int) -> str:
    return (datetime.now(UTC) + timedelta(seconds=max(60, seconds))).isoformat().replace("+00:00", "Z")


def _session_lock_key(session_id: str) -> int:
    """Hash session_id into a signed 64-bit int suitable for pg_advisory_lock."""
    digest = hashlib.sha256(session_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big", signed=True)


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
        avatar=row["avatar"] if "avatar" in row.keys() else None,
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def _mobile_login_token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _dedupe_legacy_history_items(items: list[TimelineItem]) -> list[TimelineItem]:
    live_keys = {_live_duplicate_key(item) for item in items}
    live_keys.discard(None)
    canonical_keys = {_canonical_duplicate_key(item) for item in items}
    canonical_keys.discard(None)
    result: list[TimelineItem] = []
    for item in items:
        snapshot_key = _snapshot_duplicate_key(item)
        if snapshot_key is not None and snapshot_key in live_keys:
            continue
        legacy_key = _legacy_duplicate_key(item)
        if legacy_key is not None and legacy_key in canonical_keys:
            continue
        result.append(item)
    return result


def _timeline_item_unchanged(existing: TimelineItem, incoming: TimelineItemIn) -> bool:
    if _timeline_source_client_message_id(existing) != _timeline_source_client_message_id(incoming):
        return False
    return (
        existing.contentHash == incoming.contentHash
        and existing.revision == incoming.revision
        and existing.status == incoming.status
    )


def _should_keep_existing_timeline_item(existing: TimelineItem, incoming: TimelineItemIn) -> bool:
    existing_client_message_id = _timeline_source_client_message_id(existing)
    incoming_client_message_id = _timeline_source_client_message_id(incoming)
    if existing_client_message_id and not incoming_client_message_id:
        return True
    if incoming_client_message_id and not existing_client_message_id:
        return False
    if _timeline_item_unchanged(existing, incoming):
        return True
    if existing.type != incoming.type:
        return False
    if existing.type == "tool":
        return _content_completeness_score(existing.content) > _content_completeness_score(incoming.content)
    if existing.type == "message":
        return _message_text_length(existing.content) > _message_text_length(incoming.content)
    return False


def _timeline_source_client_message_id(item: TimelineItem | TimelineItemIn) -> str | None:
    value = item.source.clientMessageId
    return value if isinstance(value, str) and value else None


def _content_completeness_score(content: Any) -> int:
    if not isinstance(content, dict):
        return 0
    score = len(_json_dumps(content))
    for key in ("outputText", "outputPreview", "result", "error", "approval"):
        if content.get(key) not in (None, "", [], {}):
            score += 1000
    output_length = content.get("outputLength")
    if isinstance(output_length, int):
        score += output_length
    return score


def _message_text_length(content: Any) -> int:
    if not isinstance(content, dict):
        return 0
    text = content.get("text")
    return len(text) if isinstance(text, str) else 0


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


def _timeline_item_from_input(
    item: TimelineItemIn,
    *,
    updated_seq: int,
    now: str,
    order_seq: int | None = None,
) -> TimelineItem:
    data = item.model_dump()
    data["updatedSeq"] = updated_seq
    if order_seq is not None:
        data["orderSeq"] = order_seq
    data["createdAt"] = item.createdAt or now
    data["updatedAt"] = item.updatedAt or now
    return TimelineItem.model_validate(data)


def _canonical_duplicate_key(item: TimelineItem) -> tuple[str, str | None, str, str] | None:
    derived_key = item.source.derivedKey
    if not derived_key or derived_key.startswith("history-"):
        return None
    if item.type not in {"message", "turn.start", "turn.end"}:
        return None
    return (item.type, item.turnId, derived_key, _json_dumps(item.content))


def _live_duplicate_key(item: TimelineItem) -> tuple[str, str | None, str, str] | None:
    if item.type != "message":
        return _live_reasoning_duplicate_key(item)
    source_item_id = item.source.itemId
    if not source_item_id or source_item_id.startswith("item-"):
        return None
    return (item.type, item.turnId, str(item.role or ""), _json_dumps(item.content))


def _snapshot_duplicate_key(item: TimelineItem) -> tuple[str, str | None, str, str] | None:
    if item.type != "message":
        return _snapshot_reasoning_duplicate_key(item)
    source_item_id = item.source.itemId
    if not source_item_id or not source_item_id.startswith("item-"):
        return None
    return (item.type, item.turnId, str(item.role or ""), _json_dumps(item.content))


def _live_reasoning_duplicate_key(item: TimelineItem) -> tuple[str, str | None, str, str] | None:
    if not _is_reasoning_timeline_item(item):
        return None
    source_item_id = item.source.itemId
    if not source_item_id or source_item_id.startswith("item-"):
        return None
    return (item.type, item.turnId, "reasoning", _json_dumps(item.content))


def _snapshot_reasoning_duplicate_key(item: TimelineItem) -> tuple[str, str | None, str, str] | None:
    if not _is_reasoning_timeline_item(item):
        return None
    source_item_id = item.source.itemId
    if not source_item_id or not source_item_id.startswith("item-"):
        return None
    return (item.type, item.turnId, "reasoning", _json_dumps(item.content))


def _is_reasoning_timeline_item(item: TimelineItem) -> bool:
    if item.type != "system" or item.role != "system":
        return False
    content = item.content
    return isinstance(content, dict) and content.get("kind") == "reasoning"


def _legacy_duplicate_key(item: TimelineItem) -> tuple[str, str | None, str, str] | None:
    derived_key = item.source.derivedKey
    if not derived_key or not derived_key.startswith("history-"):
        return None
    if item.type not in {"message", "turn.start", "turn.end"}:
        return None
    return (item.type, item.turnId, derived_key.removeprefix("history-"), _json_dumps(item.content))


# Catalog seeds. Mirror the picker UX of each runtime's TUI (Claude shift+cmd+M
# for modes, shift+cmd+. for models / effort). Insert order is meaningful only
# in that sort_order drives the dropdown order; the table itself is keyed by
# (runtime, key) so re-running seed is idempotent.

SEED_AGENT_MODES: list[dict[str, Any]] = [
    {
        "runtime": "claude",
        "key": "default",
        "display_label": "Ask permissions",
        "description": "Prompt before destructive actions. Read-only commands run automatically.",
        "is_default": 1,
        "sort_order": 1,
    },
    {
        "runtime": "claude",
        "key": "acceptEdits",
        "display_label": "Accept edits",
        "description": "Auto-approve file edits; still ask for shell commands.",
        "is_default": 0,
        "sort_order": 2,
    },
    {
        "runtime": "claude",
        "key": "plan",
        "display_label": "Plan mode",
        "description": "Read-only planning. No writes, no commands.",
        "is_default": 0,
        "sort_order": 3,
    },
    {
        "runtime": "claude",
        "key": "auto",
        "display_label": "Auto mode",
        "description": "Run everything; background classifier flags risky actions.",
        "is_default": 0,
        "sort_order": 4,
    },
    {
        "runtime": "claude",
        "key": "bypassPermissions",
        "display_label": "Bypass permissions ⚠️",
        "description": "Skip every prompt. Only the rm -rf / hard-fuse remains.",
        "is_default": 0,
        "sort_order": 5,
    },
]


SEED_AGENT_MODELS: list[dict[str, Any]] = [
    {
        "runtime": "claude",
        "key": "claude-opus-4-7",
        "display_label": "Opus 4.7",
        "description": None,
        "is_default": 1,
        "sort_order": 1,
    },
    {
        "runtime": "claude",
        "key": "claude-opus-4-7[1m]",
        "display_label": "Opus 4.7 1M",
        "description": None,
        "is_default": 0,
        "sort_order": 2,
    },
    {
        "runtime": "claude",
        "key": "claude-sonnet-4-6",
        "display_label": "Sonnet 4.6",
        "description": None,
        "is_default": 0,
        "sort_order": 3,
    },
    {
        "runtime": "claude",
        "key": "claude-haiku-4-5",
        "display_label": "Haiku 4.5",
        "description": None,
        "is_default": 0,
        "sort_order": 4,
    },
    {
        "runtime": "claude",
        "key": "claude-opus-4-6",
        "display_label": "Opus 4.6 Legacy",
        "description": None,
        "is_default": 0,
        "sort_order": 5,
    },
]


def _seed_agent_catalog_sync(async_url: str) -> None:
    """Idempotent synchronous seed for the agent catalog tables.

    Mirrors init_db_sync's sqlite-fast-path / worker-thread-for-async-only
    backends dance so the catalog is populated even when callers skip the
    FastAPI lifespan (TestClient used without `with`).
    """
    if async_url.startswith("sqlite+aiosqlite:"):
        sync_url = "sqlite:" + async_url[len("sqlite+aiosqlite:"):]
    elif async_url.startswith("sqlite:"):
        sync_url = async_url
    else:
        _seed_agent_catalog_async_in_thread(async_url)
        return

    sync_engine = create_engine(sync_url, future=True)
    try:
        with sync_engine.begin() as conn:
            for table, rows in _CATALOG_SEED_PLAN:
                _seed_table_sync(conn, table, rows)
    finally:
        sync_engine.dispose()


def _seed_table_sync(conn: Any, table: Any, rows: list[dict[str, Any]]) -> None:
    if not rows:
        return
    existing = conn.execute(
        select(table.c.runtime, table.c.key).where(
            table.c.runtime.in_({row["runtime"] for row in rows})
        )
    ).all()
    present = {(row.runtime, row.key) for row in existing}
    missing = [row for row in rows if (row["runtime"], row["key"]) not in present]
    if missing:
        conn.execute(insert(table), missing)


def _seed_agent_catalog_async_in_thread(async_url: str) -> None:
    import threading

    captured: list[BaseException] = []

    async def _run() -> None:
        engine = create_async_engine(async_url, future=True)
        try:
            async with engine.begin() as conn:
                for table, rows in _CATALOG_SEED_PLAN:
                    if not rows:
                        continue
                    existing = (
                        await conn.execute(
                            select(table.c.runtime, table.c.key).where(
                                table.c.runtime.in_({row["runtime"] for row in rows})
                            )
                        )
                    ).all()
                    present = {(row.runtime, row.key) for row in existing}
                    missing = [row for row in rows if (row["runtime"], row["key"]) not in present]
                    if missing:
                        await conn.execute(insert(table), missing)
        finally:
            await engine.dispose()

    def _runner() -> None:
        try:
            asyncio.run(_run())
        except BaseException as exc:  # noqa: BLE001
            captured.append(exc)

    thread = threading.Thread(target=_runner, name="seed-agent-catalog-sync")
    thread.start()
    thread.join()
    if captured:
        raise captured[0]


SEED_AGENT_EFFORTS: list[dict[str, Any]] = [
    {
        "runtime": "claude",
        "key": "low",
        "display_label": "Low",
        "description": None,
        "is_default": 0,
        "sort_order": 1,
    },
    {
        "runtime": "claude",
        "key": "medium",
        "display_label": "Medium",
        "description": None,
        "is_default": 0,
        "sort_order": 2,
    },
    {
        "runtime": "claude",
        "key": "high",
        "display_label": "High",
        "description": None,
        "is_default": 0,
        "sort_order": 3,
    },
    {
        "runtime": "claude",
        "key": "xhigh",
        "display_label": "Extra high",
        "description": None,
        "is_default": 1,
        "sort_order": 4,
    },
    {
        "runtime": "claude",
        "key": "max",
        "display_label": "Max",
        "description": None,
        "is_default": 0,
        "sort_order": 5,
    },
]


_CATALOG_SEED_PLAN: tuple[tuple[Any, list[dict[str, Any]]], ...] = (
    (agent_modes_t, SEED_AGENT_MODES),
    (agent_models_t, SEED_AGENT_MODELS),
    (agent_efforts_t, SEED_AGENT_EFFORTS),
)


__all__ = [name for name in globals() if not name.startswith("__")]
