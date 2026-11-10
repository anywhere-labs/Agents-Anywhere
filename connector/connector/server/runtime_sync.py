from __future__ import annotations

import asyncio
import hashlib
import json
import random
import secrets
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from typing import Any

import httpx
from pydantic import ValidationError

from connector.core.config import ConnectorConfig
from connector.logging import logger
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeHostClient,
    RuntimeStatus,
    RuntimeSupervisor,
    RuntimeTimelineItem,
    RuntimeTimelineSnapshot,
    RuntimeUnavailableError,
    RuntimeUnsupportedError,
    SessionMeta,
    SessionNotice,
    SessionSourceObservation,
    SessionState,
)
from connector.server.errors import ConnectorNetworkError
from connector.server.ingest import ConnectorIngestRejectedError
from connector.server.runtime_host import _drop_none, _timeline_item_payload
from connector.server.runtime_rpc_payloads import session_notice_payload

NotificationSender = Callable[[str, dict[str, Any]], Awaitable[None]]
IngestNotificationSender = Callable[[list[dict[str, Any]]], Awaitable[None]]
SnapshotIngester = Callable[..., Awaitable[None]]
PreferencesReader = Callable[[], dict[str, Any]]
SyncStateFlusher = Callable[[], Awaitable[bool]]
ACTIVE_SESSION_SYNC_SKIP_STATUSES: frozenset[RuntimeStatus] = frozenset(
    {"waiting", "pending", "running", "waiting_approval", "stopping"}
)
VALIDATION_ERROR_LOG_LIMIT = 5
# Connectors restarted together spread their first scan across this window.
INITIAL_SYNC_JITTER_SECONDS = 5.0
# Scan intervals vary by this fraction so that scans do not stay aligned.
SYNC_INTERVAL_JITTER = 0.2
# An unchanged inventory is not reported again until this much time has passed,
# which bounds how long the Server can disagree with the runtime.
INVENTORY_RECONCILE_SECONDS = 600.0
# Forced timeline syncs per scan after a reconnect. The rest wait for later scans;
# sessions with local changes still sync on their normal path.
RECOVERY_SESSIONS_PER_SCAN = 100
# A session whose timeline the Server refused for good (for example 413 after
# the pages could not be cut any smaller) is not read or uploaded again until
# this delay has passed. It doubles with every further refusal, up to the cap,
# so one session cannot hold up every scan of its runtime.
TIMELINE_REJECTION_BACKOFF_SECONDS = 600.0
TIMELINE_REJECTION_BACKOFF_MAX_SECONDS = 6 * 3600.0


@dataclass(frozen=True)
class _InventoryReport:
    fingerprint: str
    reconcile_at: float


@dataclass(frozen=True)
class _TimelineBackoff:
    failures: int
    retry_at: float
    # The meta and state last published while the timeline waits.
    published: tuple[SessionMeta, SessionState | None] | None = None


class RuntimeSyncRunner:
    """Keeps runtime startup and background local-session sync out of the WS loop."""

    def __init__(
        self,
        config: ConnectorConfig,
        supervisor: RuntimeSupervisor,
        host: RuntimeHostClient,
        preferences_reader: PreferencesReader,
        send_notification: NotificationSender,
        ingest_notifications: IngestNotificationSender | None = None,
        flush_sync_state: SyncStateFlusher | None = None,
        ingest_snapshot: SnapshotIngester | None = None,
    ) -> None:
        self.config = config
        self.supervisor = supervisor
        self.host = host
        self.preferences_reader = preferences_reader
        self.send_notification = send_notification
        self.ingest_notifications = ingest_notifications
        self.ingest_snapshot = ingest_snapshot
        self.flush_sync_state = flush_sync_state
        self._recovery_generation = 0
        self._recovered: dict[str, int] = {}
        self._recovered_sessions: set[tuple[str, str]] = set()
        self._inventory_reports: dict[str, _InventoryReport] = {}
        self._last_preferences: dict[str, Any] | None = None
        self._last_active_session_updates: dict[
            str, tuple[SessionMeta, SessionState]
        ] = {}
        self._timeline_backoffs: dict[str, _TimelineBackoff] = {}

    async def sync_existing_loop(self) -> None:
        if not self.config.sync_existing_on_connect:
            logger.info("existing session sync disabled")
            return
        logger.info(
            "existing session sync loop started interval_seconds={}",
            self.config.sync_interval_seconds,
        )
        interval = self.config.sync_interval_seconds
        await asyncio.sleep(random.uniform(0, min(INITIAL_SYNC_JITTER_SECONDS, interval)))
        while True:
            await self.sync_existing_once()
            await self.push_preferences_if_changed()
            await asyncio.sleep(
                interval
                * random.uniform(1 - SYNC_INTERVAL_JITTER, 1 + SYNC_INTERVAL_JITTER)
            )

    async def reconnect_event_runtimes(self) -> None:
        self._recovery_generation += 1
        self._recovered_sessions.clear()
        self._inventory_reports.clear()
        self._last_active_session_updates.clear()
        for runtime_id in self.supervisor.runtimes:
            try:
                runtime = self.supervisor.resolve_runtime(runtime_id)
                if runtime.sync_mode == "events":
                    await runtime.resynchronize()
            except RuntimeUnavailableError:
                # Not started or still connecting: its own start delivers a baseline.
                logger.info("runtime event recovery skipped; runtime not running runtime={}", runtime_id)
            except Exception:
                logger.exception("runtime event recovery deferred runtime={}", runtime_id)

    async def sync_existing_once(self) -> None:
        for runtime_id in self.supervisor.runtimes:
            runtime_started_at = time.monotonic()
            recovery_generation = self._recovery_generation
            recover = self._recovered.get(runtime_id, 0) != recovery_generation
            failed = False
            try:
                runtime = self.supervisor.resolve_runtime(runtime_id)
                if runtime.sync_mode == "events":
                    continue
                logger.info(
                    "existing session sync runtime started runtime={}", runtime_id
                )
                entry = self.supervisor.entry(runtime_id)
                await self.push_runtime_catalogs(runtime)
                inventory_scan_token: str | None = None
                runtime_type = entry.runtime_type
                scoped_runtime_id = entry.runtime_id
                source_in_inventory = runtime.supports_complete_session_inventory()
                if source_in_inventory:
                    sessions = await self._read_unchanged_inventory(
                        runtime, runtime_id
                    )
                    if sessions is None:
                        inventory_scan_token = secrets.token_hex(16)
                        sessions = await self._begin_inventory(
                            runtime,
                            runtime_type,
                            scoped_runtime_id,
                            inventory_scan_token,
                        )
                else:
                    sessions = await runtime.list_sessions(limit=100, force=False)
                timeline_sync_count = sum(
                    1 for session in sessions if session_requires_timeline_sync(session)
                )
                logger.info(
                    "existing session sync runtime discovered runtime={} sessions={} timeline_syncs={}",
                    runtime_id,
                    len(sessions),
                    timeline_sync_count,
                )
                recovery_budget = RECOVERY_SESSIONS_PER_SCAN
                recovery_deferred = False
                for session in sessions:
                    try:
                        recovery_key = (runtime_id, session.session_id)
                        recover_session = recover and recovery_key not in self._recovered_sessions
                        if recover_session and recovery_budget <= 0:
                            recover_session = False
                            recovery_deferred = True
                        if recover_session:
                            recovery_budget -= 1
                            session = replace(session, metadata={
                                **dict(session.metadata),
                                "sync": {"changed": True, "requires_timeline_sync": True},
                            })
                        completed = await self.sync_existing_session(
                            runtime, session, source_in_inventory=source_in_inventory,
                            recovering=recover_session,
                        )
                        if completed is False:
                            failed = True
                        elif recover_session and recovery_generation == self._recovery_generation:
                            self._recovered_sessions.add(recovery_key)
                    except ConnectorNetworkError as exc:
                        logger.warning(
                            "existing session sync network failure runtime={} session_id={} external_session_id={} error={}",
                            session.runtime,
                            session.session_id,
                            session.external_session_id,
                            exc,
                        )
                        failed = True
                        continue
                    except ValidationError as exc:
                        logger.error(
                            "existing session sync validation failed runtime={} session_id={} external_session_id={} validation_errors={} details={}",
                            session.runtime,
                            session.session_id,
                            session.external_session_id,
                            exc.error_count(),
                            validation_error_summary(exc),
                        )
                        failed = True
                        continue
                    except Exception:  # noqa: BLE001
                        logger.exception(
                            "existing session sync failed runtime={} session_id={} external_session_id={}",
                            session.runtime,
                            session.session_id,
                            session.external_session_id,
                        )
                        failed = True
                        continue
                if inventory_scan_token is not None:
                    await self._ingest_scanner_notifications(
                        [
                            _inventory_complete_notification(
                                runtime_type,
                                scoped_runtime_id,
                                inventory_scan_token,
                                sessions,
                                complete=True,
                            )
                        ]
                    )
                    self._inventory_reports[runtime_id] = _InventoryReport(
                        fingerprint=_inventory_fingerprint(sessions),
                        reconcile_at=time.monotonic()
                        + INVENTORY_RECONCILE_SECONDS
                        * random.uniform(
                            1 - SYNC_INTERVAL_JITTER, 1 + SYNC_INTERVAL_JITTER
                        ),
                    )
                if not failed and not recovery_deferred:
                    self._recovered[runtime_id] = recovery_generation
                logger.info(
                    "existing session sync runtime completed runtime={} sessions={} elapsed_ms={:.1f}",
                    runtime_id,
                    len(sessions),
                    (time.monotonic() - runtime_started_at) * 1000,
                )
            except RuntimeUnavailableError:
                if self.runtime_has_config(runtime_id):
                    logger.info(
                        "existing session sync runtime unavailable runtime={}",
                        runtime_id,
                    )
                continue
            except ConnectorNetworkError as exc:
                logger.warning(
                    "existing {} session sync network failure error={}",
                    runtime_id,
                    exc,
                )
            except TimeoutError:
                logger.warning("existing {} session sync timed out", runtime_id)
            except Exception:  # noqa: BLE001
                logger.exception("existing {} session sync failed", runtime_id)
        if self.flush_sync_state is not None:
            try:
                await self.flush_sync_state()
            except Exception:  # noqa: BLE001
                logger.exception("history scanner sync state flush failed")

    async def _read_unchanged_inventory(
        self, runtime: AgentRuntime, runtime_id: str
    ) -> tuple[SessionMeta, ...] | None:
        """Return the inventory when the Server already has it, otherwise ``None``.

        A scan has to begin before the runtime is listed, so that writes landing
        during the listing win over it. A changed inventory is therefore listed
        again under a new scan rather than reported from this read.
        """
        report = self._inventory_reports.get(runtime_id)
        if report is None or time.monotonic() >= report.reconcile_at:
            return None
        sessions = await runtime.list_complete_session_inventory(
            page_size=100,
            force=False,
        )
        return sessions if _inventory_fingerprint(sessions) == report.fingerprint else None

    async def _begin_inventory(
        self,
        runtime: AgentRuntime,
        runtime_type: str,
        runtime_id: str,
        scan_token: str,
    ) -> tuple[SessionMeta, ...]:
        await self._ingest_scanner_notifications(
            [_inventory_begin_notification(runtime_type, runtime_id, scan_token)]
        )
        try:
            return await runtime.list_complete_session_inventory(
                page_size=100,
                force=False,
            )
        except Exception:
            await self._ingest_scanner_notifications(
                [
                    _inventory_complete_notification(
                        runtime_type,
                        runtime_id,
                        scan_token,
                        (),
                        complete=False,
                    )
                ]
            )
            raise

    async def sync_existing_session(
        self,
        runtime: AgentRuntime,
        session: SessionMeta,
        *,
        source_in_inventory: bool = False,
        recovering: bool = False,
    ) -> bool | None:
        """Publish one discovered session and any required fresh timeline.

        Side effects:
        - upserts new or changed session meta to the platform
        - when the runtime marks the session as changed, reads and pushes its
          timeline snapshot, current state, and active notices
        - publishes an active session's meta and state once per distinct update
        """
        if not session_requires_timeline_sync(session):
            if session_sync_changed(session) is False:
                if session.source_state is not None and not source_in_inventory:
                    await self.host.session_source_update(
                        SessionSourceObservation(
                            session_id=session.session_id,
                            external_session_id=session.external_session_id,
                            runtime=session.runtime,
                            runtime_id=session.runtime_id,
                            state=session.source_state,
                        )
                    )
                return
            await self._ingest_scanner_notifications(
                [_session_meta_notification(session)]
            )
            return
        state = await runtime.get_session_state(
            session.session_id,
            session.external_session_id,
        )
        active = state is not None and state.status in ACTIVE_SESSION_SYNC_SKIP_STATUSES
        if active and not recovering:
            active_update = (session, state)
            if (
                self._last_active_session_updates.get(session.session_id)
                == active_update
            ):
                logger.debug(
                    "existing session sync suppressed unchanged active session runtime={} session_id={} status={}",
                    session.runtime,
                    session.session_id,
                    state.status,
                )
                return
            await self._ingest_scanner_notifications(
                [
                    _session_meta_notification(session),
                    _session_state_notification(state),
                ]
            )
            self._last_active_session_updates[session.session_id] = active_update
            logger.info(
                "existing session sync deferred active session runtime={} session_id={} status={}",
                session.runtime,
                session.session_id,
                state.status,
            )
            return
        self._last_active_session_updates.pop(session.session_id, None)
        backoff = self._timeline_backoffs.get(session.session_id)
        if backoff is not None and time.monotonic() < backoff.retry_at:
            logger.debug(
                "existing session timeline sync backing off runtime={} session_id={} retry_in_seconds={:.0f}",
                session.runtime,
                session.session_id,
                backoff.retry_at - time.monotonic(),
            )
            await self._publish_while_backing_off(session, state, backoff)
            return None
        try:
            completed = await self._sync_session_timeline(
                runtime, session, state, active=active, recovering=recovering
            )
        except Exception as exc:
            if not _permanently_rejected(exc):
                raise
            backoff = self._back_off_timeline(session, backoff, exc)
            await self._publish_while_backing_off(session, state, backoff)
            return None
        self._timeline_backoffs.pop(session.session_id, None)
        return completed

    async def _sync_session_timeline(
        self,
        runtime: AgentRuntime,
        session: SessionMeta,
        state: SessionState | None,
        *,
        active: bool,
        recovering: bool,
    ) -> bool:
        logger.info(
            "existing session timeline sync started runtime={} session_id={} external_session_id={}",
            session.runtime,
            session.session_id,
            session.external_session_id,
        )
        read_elapsed_ms = 0.0
        publish_elapsed_ms = 0.0
        synced_items = 0
        read_started_at = time.monotonic()
        prepared = await runtime.prepare_session_timeline_sync(
            session.session_id,
            session.external_session_id,
        )
        snapshot: RuntimeTimelineSnapshot | None = None
        if prepared is not None:
            read_elapsed_ms = (time.monotonic() - read_started_at) * 1000
            snapshot = prepared.snapshot
            synced_items = len(snapshot.items) if snapshot is not None else 0
        else:
            read_started_at = time.monotonic()
            snapshot = await runtime.get_session_snapshot(
                session.session_id,
                session.external_session_id,
            )
            read_elapsed_ms = (time.monotonic() - read_started_at) * 1000
            synced_items = len(snapshot.items)
            logger.info(
                "existing session timeline sync read runtime={} session_id={} items={} complete={} elapsed_ms={:.1f}",
                snapshot.runtime,
                snapshot.session_id,
                synced_items,
                snapshot.complete,
                read_elapsed_ms,
            )
        deferred_replacement = recovering and active and snapshot is not None and snapshot.complete
        if recovering and active and snapshot is not None:
            snapshot = replace(snapshot, complete=False)
        notices = await runtime.get_session_notices(
            session.session_id,
            session.external_session_id,
        )
        trailing = []
        if state is not None:
            trailing.append(_session_state_notification(state))
        trailing.extend(_notice_notification(notice) for notice in notices)
        publish_started_at = time.monotonic()
        if snapshot is not None and self.ingest_snapshot is not None:
            # Paged by size: a history above the request limit goes out as
            # several requests instead of one the Server refuses.
            meta = _session_meta_notification(session)["params"]
            await self.ingest_snapshot(
                snapshot.runtime,
                snapshot.runtime_id or session.runtime_id or snapshot.runtime,
                snapshot.session_id,
                {key: value for key, value in meta.items() if key not in {"runtime", "runtimeId", "sessionId"}},
                _timeline_sync_items(snapshot, fallback_item_time=session.ordering_time),
                complete=snapshot.complete,
                trailing=trailing,
            )
        else:
            notifications = [_session_meta_notification(session)]
            if snapshot is not None:
                notifications.append(
                    _timeline_sync_notification(
                        snapshot,
                        fallback_item_time=session.ordering_time,
                    )
                )
            notifications.extend(trailing)
            await self._ingest_scanner_notifications(notifications)
        publish_elapsed_ms = (time.monotonic() - publish_started_at) * 1000
        if prepared is not None and prepared.commit is not None and not deferred_replacement:
            await prepared.commit()
        if publish_elapsed_ms >= 250 or synced_items >= 100:
            logger.info(
                "existing session timeline sync published runtime={} session_id={} items={} elapsed_ms={:.1f}",
                session.runtime,
                session.session_id,
                synced_items,
                publish_elapsed_ms,
            )
        logger.info(
            "existing session sync completed runtime={} session_id={} items={} notices={} read_elapsed_ms={:.1f} publish_elapsed_ms={:.1f}",
            session.runtime,
            session.session_id,
            synced_items,
            len(notices),
            read_elapsed_ms,
            publish_elapsed_ms,
        )
        # Keep this recovery generation pending until deletion reconciliation is
        # safe; otherwise an unchanged inventory marker could suppress its retry.
        return not deferred_replacement

    def _back_off_timeline(
        self,
        session: SessionMeta,
        previous: _TimelineBackoff | None,
        error: Exception,
    ) -> _TimelineBackoff:
        failures = (previous.failures if previous is not None else 0) + 1
        delay = min(
            TIMELINE_REJECTION_BACKOFF_MAX_SECONDS,
            TIMELINE_REJECTION_BACKOFF_SECONDS * 2 ** (failures - 1),
        ) * random.uniform(1 - SYNC_INTERVAL_JITTER, 1 + SYNC_INTERVAL_JITTER)
        backoff = _TimelineBackoff(failures=failures, retry_at=time.monotonic() + delay)
        self._timeline_backoffs[session.session_id] = backoff
        logger.warning(
            "existing session timeline rejected; skipping it for {:.0f}s runtime={} session_id={} external_session_id={} failures={} error={}",
            delay,
            session.runtime,
            session.session_id,
            session.external_session_id,
            failures,
            error,
        )
        return backoff

    async def _publish_while_backing_off(
        self,
        session: SessionMeta,
        state: SessionState | None,
        backoff: _TimelineBackoff,
    ) -> None:
        """Keep the session and its status current while its timeline waits."""
        update = (session, state)
        if backoff.published == update:
            return
        notifications = [_session_meta_notification(session)]
        if state is not None:
            notifications.append(_session_state_notification(state))
        await self._ingest_scanner_notifications(notifications)
        self._timeline_backoffs[session.session_id] = replace(backoff, published=update)

    async def _ingest_scanner_notifications(
        self,
        notifications: list[dict[str, Any]],
    ) -> None:
        if self.ingest_notifications is not None:
            await self.ingest_notifications(notifications)
            return
        for notification in notifications:
            await self.send_notification(
                notification["method"],
                notification["params"],
            )

    async def push_runtime_catalogs(
        self,
        runtime: AgentRuntime,
    ) -> None:
        """Read and publish runtime-level catalogs before session sync.

        Side effects:
        - reads model and permission catalogs from the runtime
        - sends catalog updates through the runtime host when available
        """

        try:
            model_catalog = await runtime.list_model_catalog(query=None, limit=200)
            await self.host.model_catalog_update(model_catalog)
        except RuntimeUnsupportedError:
            pass
        try:
            permission_catalog = await runtime.list_permission_catalog(
                query=None, limit=200
            )
            await self.host.permission_catalog_update(permission_catalog)
        except RuntimeUnsupportedError:
            pass

    async def push_preferences_if_changed(self) -> None:
        try:
            current = self.preferences_reader()
        except Exception:  # noqa: BLE001
            logger.exception("reading local preferences failed")
            return
        if not isinstance(current, dict):
            return
        # readAt is a per-call timestamp — strip it before diffing so we don't
        # push an "update" every cycle when nothing actually changed.
        if _preferences_signature(current) == _preferences_signature(
            self._last_preferences or {}
        ):
            return
        self._last_preferences = current
        await self.send_notification("connector.preferencesUpdated", current)

    def runtime_has_config(self, runtime_id: str) -> bool:
        entry = self.supervisor.entry(runtime_id)
        return entry.config is not None


def validation_error_summary(error: ValidationError) -> str:
    details = error.errors(
        include_url=False,
        include_context=False,
        include_input=False,
    )
    summarized: list[str] = []
    for detail in details[:VALIDATION_ERROR_LOG_LIMIT]:
        location = ".".join(str(part) for part in detail.get("loc", ())) or "<root>"
        message = str(detail.get("msg") or "validation failed")
        error_type = str(detail.get("type") or "validation_error")
        summarized.append(f"{location}: {message} [{error_type}]")
    remaining = len(details) - len(summarized)
    if remaining > 0:
        summarized.append(f"... {remaining} more")
    return "; ".join(summarized)


def _preferences_signature(prefs: dict[str, Any]) -> tuple[tuple[str, Any], ...]:
    """Stable signature ignoring volatile `readAt`.

    Lets us detect real user-driven changes instead of re-pushing every poll
    cycle.
    """
    return tuple(sorted((k, v) for k, v in prefs.items() if k != "readAt"))


def session_requires_timeline_sync(session: SessionMeta) -> bool:
    sync = session.metadata.get("sync")
    if not isinstance(sync, dict):
        return False
    return sync.get("requires_timeline_sync") is True


def session_sync_changed(session: SessionMeta) -> bool | None:
    sync = session.metadata.get("sync")
    if not isinstance(sync, dict):
        return None
    changed = sync.get("changed")
    return changed if isinstance(changed, bool) else None


def _session_meta_notification(session: SessionMeta) -> dict[str, Any]:
    return {
        "method": "session.meta.upsert",
        "params": _drop_none(
            {
                "sessionId": session.session_id,
                "runtime": session.runtime,
                "runtimeId": session.runtime_id,
                "externalSessionId": session.external_session_id,
                "title": session.title,
                "cwd": session.cwd,
                "lastActivityAt": session.ordering_time,
                "sourceObservedAt": (
                    session.source_state.observed_at
                    if session.source_state is not None
                    else None
                ),
                "sourceState": (
                    {
                        "availability": session.source_state.availability,
                        "reason": session.source_state.reason,
                        "observedAt": session.source_state.observed_at,
                        "observationOrigin": session.source_state.observation_origin,
                    }
                    if session.source_state is not None
                    else None
                ),
                "metadata": dict(session.metadata),
            }
        ),
    }


def _inventory_begin_notification(
    runtime_type: str,
    runtime_id: str,
    scan_token: str,
) -> dict[str, Any]:
    return {
        "method": "session.inventory.begin",
        "params": {
            "runtime": runtime_type,
            "runtimeId": runtime_id,
            "scanToken": scan_token,
        },
    }


def _inventory_complete_notification(
    runtime_type: str,
    runtime_id: str,
    scan_token: str,
    sessions: tuple[SessionMeta, ...],
    *,
    complete: bool,
) -> dict[str, Any]:
    return {
        "method": "session.inventory.complete",
        "params": {
            "runtime": runtime_type,
            "runtimeId": runtime_id,
            "scanToken": scan_token,
            "complete": complete,
            "sessions": [
                _drop_none(
                    {
                        "sessionId": session.session_id,
                        "externalSessionId": session.external_session_id,
                        "sourceState": _inventory_source_state(session),
                    }
                )
                for session in sessions
            ],
        },
    }


def _inventory_fingerprint(sessions: tuple[SessionMeta, ...]) -> str:
    """Identify what a scan would report, ignoring when it was observed."""
    entries = []
    for session in sessions:
        source_state = _inventory_source_state(session)
        if isinstance(source_state, dict):
            source_state = {
                key: value for key, value in source_state.items() if key != "observedAt"
            }
        entries.append([session.session_id, session.external_session_id, source_state])
    entries.sort(key=lambda entry: entry[0])
    encoded = json.dumps(entries, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


def _inventory_source_state(session: SessionMeta) -> str | dict[str, Any]:
    if session.source_state is not None:
        return _drop_none(
            {
                "availability": session.source_state.availability,
                "reason": session.source_state.reason,
                "observedAt": session.source_state.observed_at,
                "observationOrigin": session.source_state.observation_origin,
            }
        )
    metadata = session.metadata
    if any(
        metadata.get(key) is True
        for key in (
            "hidden",
            "localArchived",
            "local_archived",
            "localDeleted",
            "local_deleted",
        )
    ):
        return "hidden"
    if metadata.get("resumeSupported") is False or metadata.get("resumable") is False:
        return "hidden"
    local_state = metadata.get("localState") or metadata.get("local_state")
    return (
        "hidden" if local_state in {"archived", "deleted", "unresumable"} else "visible"
    )


def _permanently_rejected(error: Exception) -> bool:
    """Whether sending the same timeline again would be refused again."""
    if isinstance(error, ConnectorIngestRejectedError):
        return True
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        return 400 <= status < 500 and status not in {401, 408, 429}
    return False


def _timeline_sync_items(
    snapshot: RuntimeTimelineSnapshot,
    fallback_item_time: str | None = None,
) -> list[dict[str, Any]]:
    return [
        _runtime_timeline_item_payload(item, fallback_time=fallback_item_time)
        for item in snapshot.items
        if item.type not in {"turn.start", "turn.end"}
    ]


def _timeline_sync_notification(
    snapshot: RuntimeTimelineSnapshot,
    fallback_item_time: str | None = None,
) -> dict[str, Any]:
    return {
        "method": "timeline.sync",
        "params": _drop_none(
            {
                "sessionId": snapshot.session_id,
                "runtime": snapshot.runtime,
                "runtimeId": snapshot.runtime_id,
                "externalSessionId": snapshot.external_session_id,
                "items": _timeline_sync_items(snapshot, fallback_item_time),
                "complete": snapshot.complete,
                "metadata": dict(snapshot.metadata),
            }
        ),
    }


def _runtime_timeline_item_payload(
    item: RuntimeTimelineItem,
    fallback_time: str | None = None,
) -> dict[str, Any]:
    payload = _timeline_item_payload(item)
    if fallback_time is not None:
        payload.setdefault("createdAt", fallback_time)
        payload.setdefault("updatedAt", fallback_time)
    return payload


def _session_state_notification(state: SessionState) -> dict[str, Any]:
    return {
        "method": "session.state.updated",
        "params": _drop_none(
            {
                "sessionId": state.session_id,
                "runtime": state.runtime,
                "runtimeId": state.runtime_id,
                "externalSessionId": state.external_session_id,
                "status": state.status,
                "statusReason": state.status_reason,
                "error": dict(state.error) if state.error is not None else None,
                "selections": dict(state.selections),
                "metadata": dict(state.metadata),
            }
        ),
    }


def _notice_notification(notice: SessionNotice) -> dict[str, Any]:
    return {"method": "notice.upsert", "params": session_notice_payload(notice)}
