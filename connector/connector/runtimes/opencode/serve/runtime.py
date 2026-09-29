"""OpenCode runtime that attaches to the host's own service over HTTP.

This is the shape Codex (`codex app-server`) and Claude (SDK subprocess) already
use: the Connector is the client, OpenCode stays untouched, and nothing is
installed inside the host process. Discovery is the machine-wide
`service.json` registration; every capability below maps to an endpoint measured
on a live 2.0.18 service (`docs/opencode-server-surface.md`).

Session identity is the compatibility-critical part: Agents Anywhere knows
sessions by `mappers.platform_session_id(namespace, externalId)`, which is
derived from a hash and therefore not invertible, so the runtime keeps a
bidirectional map filled by every inventory read. A session that has never been
seen is resolved by fetching the inventory again rather than by guessing.

The approval policy is ported unchanged from the plugin
(`src/shared/permission-policy.ts`): only ``allow_once`` / ``deny`` are ever
answerable remotely, ``always`` is refused everywhere because it would rewrite
the host's persistent rules, and the read-only allowlist is an **allowlist** -- a
denylist would silently make an unrecognised (or empty) action remote-answerable.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from collections.abc import Mapping
from contextlib import suppress
from pathlib import Path
from typing import Any, Callable

from connector.logging import logger
from connector.runtime_protocol import (
    AgentRuntime,
    RuntimeAgentCatalog,
    RuntimeCapability,
    RuntimeCapabilitySet,
    RuntimeCommand,
    RuntimeCommandResult,
    RuntimeConfig,
    RuntimeIdentity,
    RuntimeInvalidRequestError,
    RuntimeModelCatalog,
    RuntimeOperationResult,
    RuntimePermissionCatalog,
    RuntimeTimelineSnapshot,
    RuntimeUnsupportedError,
    RuntimeUpstreamError,
    SessionMeta,
    SessionNotice,
    SessionState,
)
from connector.runtime_protocol.filesystem import canonical_path
from connector.runtime_protocol.host import RuntimeHostClient
from connector.runtimes.opencode.provider_config import (
    DEFAULT_MAX_RESTART_ATTEMPTS,
    DEFAULT_RESTART_BACKOFF_MS,
)
from connector.runtimes.opencode.serve import events, mappers
from connector.runtimes.opencode.serve.client import (
    OpenCodeServerClient,
    OpenCodeServiceError,
    OpenCodeServiceUnavailable,
)
from connector.runtimes.opencode.serve.service import OpenCodeService, read_service
from connector.runtimes.opencode.serve.timeline import project_messages

RUNTIME = "opencode"
REMOTE_ALLOW_ACTION = "allow_once"
REMOTE_DENY_ACTION = "deny"
PERSISTENT_ACTION = "always"

# Mirrors permission-policy.ts READ_ONLY_ACTIONS: actions proven to only read.
READ_ONLY_ACTIONS = frozenset(
    {
        "read",
        "view",
        "cat",
        "ls",
        "list",
        "glob",
        "grep",
        "search",
        "find",
        "stat",
        "tree",
        "webfetch",
        "fetch",
        "websearch",
    }
)

DEFAULT_PAGE_SIZE = 100

#: How long the pump waits for quiet before re-reading a session's timeline. One
#: turn emits dozens of `message.part.delta` frames, and a re-read is a full
#: stored-message fetch (measured: 649 messages -> 1418 items), so the window is
#: about cost, not taste. Terminal frames bypass it.
EVENT_REFRESH_SECONDS = 2.0


class OpenCodeLocationNotLoaded(OpenCodeServiceUnavailable):
    """The service answers, but it has never loaded this instance's location.

    Kept distinct from "no service" because the user action differs: opening the
    folder in OpenCode, not starting a server.
    """

#: One source of truth for what this transport can do. Provider discovery and the
#: attached runtime both read it, so the AA descriptor can never advertise a
#: capability the runtime would then refuse (the two-predicates failure mode).
CAPABILITY_ROWS: tuple[dict[str, Any], ...] = (
    {"capabilityId": "session.list"},
    {"capabilityId": "session.getSnapshot"},
    {"capabilityId": "session.getState"},
    {"capabilityId": "session.getNotices"},
    {"capabilityId": "catalog.model"},
    {"capabilityId": "catalog.agent"},
    {"capabilityId": "session.send_message"},
    {"capabilityId": "session.interrupt"},
    {"capabilityId": "session.commands"},
    {"capabilityId": "session.interaction.approval"},
    {
        "capabilityId": "catalog.permission",
        "supported": False,
        "available": False,
        "reason": "the host exposes no permission catalog over HTTP",
    },
    {
        "capabilityId": "session.steer",
        "supported": False,
        "available": False,
        "reason": 'prompt declares delivery:"steer", but it is unproven against a live turn',
    },
    {
        "capabilityId": "runtime.attachment",
        "supported": False,
        "available": False,
        "reason": "attachment upload is not implemented on this transport yet",
    },
)


def capability_rows(directory: str | None, *, loaded: bool = True) -> list[dict[str, Any]]:
    """Complete wire-form capability rows -- both consumers read exactly these keys.

    Every row carries `supported`/`available`/`allowed`: the provider derives its
    descriptor booleans from all three (`provider_config.opencode_capabilities`),
    so a row that omits one reads as "off" there while the attached runtime would
    still serve it. That mismatch is what made a live Hub show an OpenCode runtime
    with no model catalog and no way to send a message.

    rev3 ruling 2: the discovery state rides this row's metadata and is never a
    new boolean. The host service answers `GET /api/session` with a paginated
    inventory, so with a location the host has actually loaded this really is
    `complete` -- claiming that for a location the service has never opened, or
    with no location at all, would overstate what one instance can see.
    """
    rows = [
        {
            "capabilityId": row["capabilityId"],
            "supported": bool(row.get("supported", True)),
            "available": bool(row.get("available", True)),
            "allowed": bool(row.get("supported", True)) and bool(row.get("available", True)),
            "reason": row.get("reason"),
            "metadata": dict(row.get("metadata") or {}),
        }
        for row in CAPABILITY_ROWS
    ]
    available = bool(directory) and loaded
    if not directory:
        reason = "no location configured for this instance"
    elif not loaded:
        reason = "the OpenCode service has not loaded this location yet"
    else:
        reason = None
    rows.append(
        {
            "capabilityId": "session.discovery",
            "supported": True,
            "available": available,
            "allowed": available,
            "reason": reason,
            "metadata": {"discoveryState": "complete" if available else "partial"},
        }
    )
    return rows


def requires_local_confirmation(action: object) -> bool:
    if not isinstance(action, str):
        return True
    normalized = action.strip().lower()
    return not normalized or normalized not in READ_ONLY_ACTIONS


def remote_actions(action: object) -> list[dict[str, Any]]:
    if requires_local_confirmation(action):
        return []
    return [
        {"actionId": REMOTE_ALLOW_ACTION, "label": "Allow once"},
        {"actionId": REMOTE_DENY_ACTION, "label": "Deny"},
    ]


class OpenCodeServiceRuntime(AgentRuntime):
    """Attach-only: never spawns OpenCode, only joins the registered service."""

    def __init__(
        self,
        config: RuntimeConfig,
        host: RuntimeHostClient,
        client_version: str = "1.0",
        *,
        service_reader: Callable[[], OpenCodeService | None] = read_service,
        client_factory: Callable[[OpenCodeService], OpenCodeServerClient] | None = None,
    ) -> None:
        self.config = config
        self.host = host
        self.client_version = client_version
        self._service_reader = service_reader
        self._client_factory = client_factory or (lambda service: OpenCodeServerClient(service))
        self._client: OpenCodeServerClient | None = None
        # The registration this client is actually attached to, so a re-read can
        # tell whether the host re-registered under a new pid.
        self._attached_service: OpenCodeService | None = None
        self._restart_exhausted = False
        self._identity = RuntimeIdentity(RUNTIME, "unknown", "OpenCode", runtime_id=config.runtime_id)
        self._external_by_session: dict[str, str] = {}
        self._restart_task: asyncio.Task[None] | None = None
        self._stopping = False
        self._catalog_revision = 0
        # The host's own spelling of `location`, resolved at attach time; every
        # location-scoped query uses it because the host compares strings.
        self._resolved_directory: str | None = None
        # Event pump state: the per-session durable sequence (to notice that we
        # missed frames) and the debounced re-read tasks.
        self._event_task: asyncio.Task[None] | None = None
        self._durable_seq: dict[str, int] = {}
        self._pending_refreshes: dict[str, asyncio.Task[None]] = {}
        self._event_actions: Counter[str] = Counter()

    # ------------------------------------------------------------------ identity

    @property
    def _runtime_id(self) -> str:
        return self.config.runtime_id or RUNTIME

    @property
    def sync_mode(self) -> str:
        # "events" tells the Connector "this runtime pushes its own updates", and
        # the polling scanner then skips it entirely -- with no event pump here,
        # that meant zero sessions ever reached the Hub. Report "polling" until
        # `/api/event` is actually wired up.
        return "polling"

    @property
    def identity(self) -> RuntimeIdentity:
        return self._identity

    @property
    def directory(self) -> str | None:
        value = self.config.values.get("location")
        return value if isinstance(value, str) and value else None

    @property
    def pinned_pid(self) -> int | None:
        """The pid this instance must attach to, when the config names one."""
        pid = self.config.values.get("servicePid")
        return pid if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0 else None

    # --------------------------------------------------------------- lifecycle

    async def start(self) -> None:
        self._stopping = False
        self._restart_exhausted = False
        self._restart_task = None
        await self.host.runtime_health_update(
            "starting",
            {"code": "runtime_initializing", "message": "正在连接 OpenCode 服务…", "retryable": True},
        )
        try:
            await self._attach()
        except (OpenCodeServiceUnavailable, OpenCodeServiceError, OSError, ValueError) as error:
            location_only = isinstance(error, OpenCodeLocationNotLoaded)
            with suppress(Exception):
                await self.host.runtime_health_update(
                    "starting",
                    {
                        "code": "location_not_loaded" if location_only else "runtime_unavailable",
                        "message": (
                            f"OpenCode 无法为 {self.directory} 提供服务：这个路径不是一个可打开的目录；"
                            "请先在 OpenCode 里打开这个项目。"
                            if location_only
                            else (
                                "未找到可用的 OpenCode 服务：请打开 OpenCode 桌面版，或执行 "
                                "`opencode serve --service`。"
                            )
                        ),
                        "retryable": True,
                        "detail": type(error).__name__,
                    },
                )
            self._schedule_restart()
            return
        with suppress(Exception):
            await self.host.runtime_health_update("running")
        self._start_events()

    async def _attach(self) -> dict[str, Any]:
        service = self._service_reader()
        if service is None:
            raise OpenCodeServiceUnavailable("no OpenCode service registration found")
        pinned = self.pinned_pid
        if pinned is not None and service.pid != pinned:
            # A pin is a promise about *which* OpenCode this instance drives. The
            # registration is shared per machine, so without this check two
            # instances configured for different processes would both attach to
            # whichever one registered last.
            raise OpenCodeServiceUnavailable(
                f"the registered OpenCode service is pid {service.pid}, not the pinned {pinned}"
            )
        client = self._client_factory(service)
        try:
            info = await client.verify()
            directory = await self._resolve_directory(client)
        except BaseException:
            await client.aclose()
            raise
        old = self._client
        self._client = client
        self._attached_service = service
        self._resolved_directory = directory
        self._restart_exhausted = False
        if old is not None:
            await old.aclose()
        self._identity = RuntimeIdentity(
            RUNTIME, str(info.get("version") or "unknown"), "OpenCode", runtime_id=self._runtime_id
        )
        return info

    async def _resolve_directory(self, client: OpenCodeServerClient) -> str | None:
        """Match the configured location against the directories the service loaded.

        `GET /api/session?directory=` is scoped by a **case-sensitive string
        compare** against the host's own spelling: `d:/github/agents-anywhere`
        answers an empty list, and so does a directory the host has not loaded
        (a non-absolute value is an HTTP 500). `/api/model`, `/api/agent` and
        `/api/command` ignore the parameter entirely, so an empty session list is
        the only symptom of a mistyped location -- indistinguishable at that
        layer from "this project has no sessions". Resolving through
        `/api/debug/location` recovers the host's spelling for any loaded project;
        a path that does not exist on disk is refused outright, and one that
        exists but has not been loaded yet stays unresolved, which the discovery
        capability reports as `partial` rather than pretending to be complete.
        """
        wanted = self.directory
        if wanted is None:
            return None
        loaded = _rows(await client.get("/api/debug/location"))
        target = canonical_path(wanted)
        for row in loaded:
            if not isinstance(row, Mapping):
                continue
            candidate = row.get("directory")
            if isinstance(candidate, str) and canonical_path(candidate) == target:
                return candidate
        if not Path(wanted).is_dir():
            raise OpenCodeLocationNotLoaded(
                f"{wanted!r} is not a directory the OpenCode service can load; its "
                f"locations are {[str(row.get('directory')) for row in loaded if isinstance(row, Mapping)][:5]}"
            )
        return None

    def _max_attempts(self) -> int:
        value = self.config.values.get("maxRestartAttempts")
        if isinstance(value, int) and not isinstance(value, bool):
            return max(0, value)
        return DEFAULT_MAX_RESTART_ATTEMPTS

    def _schedule_restart(self) -> None:
        if self._stopping or self._restart_task is not None or self._restart_exhausted:
            return
        attempts = self._max_attempts()
        if attempts == 0:
            # `0 or 3` used to turn an explicit "do not retry" into three retries,
            # so the registration kept being re-read against a config that said
            # otherwise. `start()` has already reported the failure; schedule nothing.
            self._restart_exhausted = True
            return

        async def loop() -> None:
            backoff = float(self.config.values.get("restartBackoffMs") or DEFAULT_RESTART_BACKOFF_MS) / 1000.0
            for _ in range(attempts):
                await asyncio.sleep(max(0.2, backoff))
                if self._stopping:
                    return
                try:
                    await self._attach()
                except Exception:
                    continue
                with suppress(Exception):
                    await self.host.runtime_health_update("running")
                self._start_events()
                return
            self._restart_exhausted = True
            with suppress(Exception):
                await self.host.runtime_health_update(
                    "starting",
                    {
                        "code": "attach_attempts_exhausted",
                        "message": (
                            f"连接 OpenCode 服务已重试 {attempts} 次仍未成功，本实例停止重试；"
                            "请打开 OpenCode 后重启该 runtime。"
                        ),
                        "retryable": True,
                    },
                )

        self._restart_task = asyncio.create_task(loop())

    # -------------------------------------------------------------- event pump

    def _start_events(self) -> None:
        if self._stopping or (self._event_task is not None and not self._event_task.done()):
            return
        self._event_task = asyncio.create_task(self._event_loop())

    async def _event_loop(self) -> None:
        """Follow `GET /api/event` and turn frames into re-reads.

        The stream cannot be resumed (`Last-Event-ID` is ignored), so this loop
        only lowers latency: the Connector's polling scanner stays the backstop,
        because a frame can be missed and a dropped connection cannot be
        replayed.
        """
        backoff = 1.0
        while not self._stopping:
            try:
                client = await self._ensure_client()
                async for frame in client.stream_events():
                    backoff = 1.0
                    await self._handle_frame(frame)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - a dropped stream is expected
                self._event_actions["stream:error"] += 1
                logger.warning("OpenCode event stream interrupted", {"error": type(error).__name__})
            if self._stopping:
                return
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30.0)

    async def _handle_frame(self, frame: Mapping[str, Any]) -> None:
        event_type = events.frame_type(frame)
        location = events.frame_location(frame)
        target = self._resolved_directory or self.directory
        foreign = (
            location is not None
            and target is not None
            and canonical_path(location) != canonical_path(target)
        )
        external = events.frame_session_id(frame)
        sequence = events.durable_sequence(frame)
        resync = False
        if sequence is not None:
            aggregate, seq = sequence
            previous = self._durable_seq.get(aggregate)
            resync = events.needs_resync(previous, seq)
            self._durable_seq[aggregate] = max(previous or -1, seq)
        actions = set(events.actions_for(event_type))
        if foreign:
            # The catalogs are service-wide (the host ignores `?directory=`), so a
            # frame from another project still means "re-read what this service
            # offers". Everything else is session-scoped and must stay out.
            catalog_only = actions & {events.REFRESH_CATALOGS}
            if not catalog_only:
                self._event_actions[f"skipped:{event_type}"] += 1
                return
            actions = catalog_only
        if resync:
            # We missed frames and cannot ask for them again: rebuild from source.
            actions.add(events.REFRESH_TIMELINE)
        if not actions:
            self._event_actions[f"ignored:{event_type or 'anonymous'}"] += 1
            return
        self._event_actions[event_type] += 1
        if not external and events.REFRESH_CATALOGS not in actions:
            return
        if events.REFRESH_CATALOGS in actions:
            await self._publish_catalogs()
        if events.STATE_RUNNING in actions:
            await self._publish_state(external, "running")
        elif events.STATE_WAITING in actions:
            await self._publish_state(external, "waiting_approval")
        elif events.STATE_ERROR in actions:
            await self._publish_state(external, "error")
        elif events.STATE_IDLE in actions:
            await self._publish_state(external, "idle", outcome=(frame.get("data") or {}).get("outcome"))
        if events.REFRESH_NOTICES in actions:
            await self._publish_notices(external)
        if events.REFRESH_SESSION in actions:
            await self._publish_session_row(external)
        if events.REFRESH_TIMELINE in actions:
            if events.STATE_IDLE in actions:
                await self._publish_timeline(external)
            else:
                self._debounce(f"timeline:{external}", self._publish_timeline, external)

    def _debounce(self, key: str, work, *args: Any) -> None:
        """Coalesce the dozens of frames one turn emits into one re-read."""
        previous = self._pending_refreshes.get(key)
        if previous is not None:
            previous.cancel()

        async def later() -> None:
            try:
                await asyncio.sleep(EVENT_REFRESH_SECONDS)
                await work(*args)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - a failed re-read is reported, not fatal
                logger.warning("OpenCode event refresh failed", {"key": key, "error": type(error).__name__})

        task = asyncio.create_task(later())
        self._pending_refreshes[key] = task
        task.add_done_callback(lambda _done: self._pending_refreshes.pop(key, None))

    def _platform_id(self, external: str) -> str:
        platform_id = mappers.platform_session_id(self.host.session_namespace, external)
        self._external_by_session[platform_id] = external
        return platform_id

    async def _publish_state(self, external: str, status: str, outcome: Any = None) -> None:
        session_id = self._platform_id(external)
        with suppress(Exception):
            await self.host.session_state_update(
                session_id=session_id,
                runtime=RUNTIME,
                status=status,  # type: ignore[arg-type]
                external_session_id=external,
                metadata={"outcome": outcome} if isinstance(outcome, str) and outcome else {},
            )
        if status == "idle" and isinstance(outcome, str) and outcome:
            with suppress(Exception):
                await self.host.session_turn_ended(
                    session_id=session_id,
                    runtime=RUNTIME,
                    external_session_id=external,
                    outcome={"succeeded": "completed", "failed": "failed", "interrupted": "cancelled"}.get(outcome, "completed"),
                )

    async def _publish_timeline(self, external: str) -> None:
        session_id = self._platform_id(external)
        snapshot = await self._snapshot(external)
        await self.host.timeline_sync(
            session_id=session_id,
            runtime=RUNTIME,
            items=snapshot.items,
            external_session_id=external,
            complete=snapshot.complete,
            metadata=snapshot.metadata,
        )

    async def _publish_notices(self, external: str) -> None:
        session_id = self._platform_id(external)
        for notice in await self.get_session_notices(session_id, external):
            await self.host.notice_upsert(notice)

    async def _publish_session_row(self, external: str) -> None:
        client = await self._ensure_client()
        row = await client.get(f"/api/session/{external}")
        if not isinstance(row, Mapping) or not self._belongs_to_location(row):
            return
        meta = mappers.session_meta(row, namespace=self.host.session_namespace)
        await self.host.session_meta_upsert(
            session_id=meta.session_id,
            runtime=RUNTIME,
            external_session_id=meta.external_session_id,
            title=meta.title,
            cwd=meta.cwd,
            ordering_time=meta.ordering_time,
            metadata=meta.metadata,
        )

    async def _publish_catalogs(self) -> None:
        await self.host.model_catalog_update(await self.list_model_catalog(limit=500))
        await self.host.agent_catalog_update(await self.list_agent_catalog())

    async def stop(self) -> None:
        self._stopping = True
        if self._event_task is not None:
            self._event_task.cancel()
            await asyncio.gather(self._event_task, return_exceptions=True)
            self._event_task = None
        refreshes = list(self._pending_refreshes.values())
        self._pending_refreshes.clear()
        for task in refreshes:
            task.cancel()
        await asyncio.gather(*refreshes, return_exceptions=True)
        if self._restart_task is not None:
            self._restart_task.cancel()
            await asyncio.gather(self._restart_task, return_exceptions=True)
            self._restart_task = None
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()

    async def get_config(self) -> RuntimeConfig:
        return self.config

    async def resynchronize(
        self, session_id: str | None = None, external_session_id: str | None = None
    ) -> None:
        await self._ensure_client()
        if session_id and external_session_id is None:
            external_session_id = self._external(session_id)
        if external_session_id:
            await self._snapshot(external_session_id)

    # ------------------------------------------------------------- capabilities

    async def get_runtime_capabilities(self) -> RuntimeCapabilitySet:
        await self._ensure_client()
        rows = [
            RuntimeCapability(
                capability_id=row["capabilityId"],
                scope="runtime",
                runtime=RUNTIME,
                runtime_id=self._runtime_id,
                connector_id=self.host.connector_id,
                supported=bool(row.get("supported", True)),
                available=bool(row.get("available", True)),
                allowed=bool(row.get("supported", True)) and bool(row.get("available", True)),
                unavailable_reason=row.get("reason"),
                metadata=row.get("metadata", {}),
            )
            for row in capability_rows(self.directory, loaded=bool(self._resolved_directory))
        ]
        self._catalog_revision += 1
        return RuntimeCapabilitySet(
            runtime=RUNTIME,
            revision=self._catalog_revision,
            capabilities=tuple(rows),
            connector_id=self.host.connector_id,
            runtime_id=self._runtime_id,
            metadata={"transport": "service-http", "serviceVersion": self._identity.runtime_version},
        )

    # ---------------------------------------------------------------- catalogs
    # Measured on a live service: `?directory=` does not scope these three
    # endpoints (identical rows for every spelling, including an unknown path),
    # so the catalogs are service-wide and the parameter is only intent here.

    async def list_model_catalog(self, query: str | None = None, limit: int = 100) -> RuntimeModelCatalog:
        client = await self._ensure_client()
        rows = await client.get("/api/model", self._location_params())
        items = [row for row in rows if isinstance(row, Mapping)]
        if query:
            needle = query.lower()
            items = [
                row
                for row in items
                if needle in str(row.get("id", "")).lower() or needle in str(row.get("name", "")).lower()
            ]
        self._catalog_revision += 1
        return mappers.model_catalog(items[: max(1, limit)], revision=self._catalog_revision)

    async def list_permission_catalog(
        self, query: str | None = None, limit: int = 100
    ) -> RuntimePermissionCatalog:
        raise RuntimeUnsupportedError("the OpenCode host service exposes no permission catalog")

    async def list_agent_catalog(self) -> RuntimeAgentCatalog:
        client = await self._ensure_client()
        rows = await client.get("/api/agent", self._location_params())
        self._catalog_revision += 1
        return mappers.agent_catalog([row for row in rows if isinstance(row, Mapping)], revision=self._catalog_revision)

    # ---------------------------------------------------------------- sessions

    async def list_sessions(
        self, limit: int = 100, cursor: str | None = None, force: bool = False
    ) -> tuple[SessionMeta, ...]:
        inventory = await self._inventory(force=force)
        try:
            offset = int(cursor) if cursor else 0
        except ValueError as error:
            raise RuntimeInvalidRequestError("cursor must be an offset into the inventory") from error
        page = inventory[offset : offset + max(1, limit)]
        return tuple(page)

    async def list_complete_session_inventory(
        self, page_size: int = DEFAULT_PAGE_SIZE, force: bool = False
    ) -> tuple[SessionMeta, ...]:
        return await self._inventory(force=force)

    def supports_complete_session_inventory(self) -> bool:
        return bool(self._resolved_directory)

    async def get_session_snapshot(
        self, session_id: str, external_session_id: str | None = None, limit: int | None = None
    ) -> RuntimeTimelineSnapshot:
        external = await self._resolve_external(session_id, external_session_id)
        return await self._snapshot(external, limit=limit)

    async def get_session_state(
        self, session_id: str, external_session_id: str | None = None
    ) -> SessionState | None:
        client = await self._ensure_client()
        external = await self._resolve_external(session_id, external_session_id)
        row = await client.get(f"/api/session/{external}")
        if not isinstance(row, Mapping):
            return None
        active = await client.get("/api/session/active")
        active_ids = {str(item.get("id")) for item in _rows(active) if isinstance(item, Mapping)}
        status = "running" if external in active_ids else "idle"
        return SessionState(
            session_id=session_id,
            external_session_id=external,
            runtime=RUNTIME,
            status=status,  # type: ignore[arg-type]
            selections=_selections(row),
            metadata={"outcome": row.get("outcome"), "agent": row.get("agent")} if row.get("outcome") else {},
        )

    async def get_session_notices(
        self, session_id: str, external_session_id: str | None = None
    ) -> tuple[SessionNotice, ...]:
        client = await self._ensure_client()
        external = await self._resolve_external(session_id, external_session_id)
        rows = await client.get(f"/api/session/{external}/permission")
        notices: list[SessionNotice] = []
        for row in _rows(rows):
            if not isinstance(row, Mapping):
                continue
            request_id = row.get("id")
            action = row.get("action")
            if not isinstance(request_id, str):
                continue
            resources = [str(item) for item in row.get("resources") or [] if isinstance(item, str)]
            notices.append(
                SessionNotice(
                    notice_id=request_id,
                    session_id=session_id,
                    runtime=RUNTIME,
                    type="interaction",
                    title=f"OpenCode 请求执行 {action}" if isinstance(action, str) else "OpenCode 请求权限",
                    message=" · ".join(resources[:4]) or None,
                    severity="warning",
                    status="open",
                    interaction_type="permission",
                    response_required=True,
                    actions=tuple(remote_actions(action)),
                    source={"runtime": RUNTIME, "event": "permission.asked", "itemId": request_id},
                    context={"action": action, "resources": resources},
                    metadata={"requiresLocalConfirmation": requires_local_confirmation(action)},
                )
            )
        return tuple(notices)

    async def get_session_capabilities(
        self, session_id: str, external_session_id: str | None = None
    ) -> RuntimeCapabilitySet:
        base = await self.get_runtime_capabilities()
        external = self._external_by_session.get(session_id) or external_session_id
        return RuntimeCapabilitySet(
            runtime=RUNTIME,
            revision=base.revision,
            capabilities=tuple(
                RuntimeCapability(
                    capability_id=row.capability_id,
                    scope="session",
                    runtime=RUNTIME,
                    version=row.version,
                    session_id=session_id,
                    connector_id=row.connector_id,
                    supported=row.supported,
                    available=row.available,
                    allowed=row.allowed,
                    unavailable_reason=row.unavailable_reason,
                    metadata=row.metadata,
                    runtime_id=row.runtime_id,
                )
                for row in base.capabilities
            ),
            session_id=session_id,
            connector_id=base.connector_id,
            runtime_id=base.runtime_id,
            metadata={**dict(base.metadata), "externalSessionId": external},
        )

    # -------------------------------------------------------------- commands

    async def list_commands(
        self, session_id: str, external_session_id: str | None = None, query: str | None = None, limit: int = 50
    ) -> tuple[RuntimeCommand, ...]:
        return await self.list_runtime_commands(limit=limit)

    async def list_runtime_commands(self, limit: int = 100) -> tuple[RuntimeCommand, ...]:
        client = await self._ensure_client()
        rows = _rows(await client.get("/api/command", self._location_params()))
        commands: list[RuntimeCommand] = []
        for row in rows:
            if not isinstance(row, Mapping):
                continue
            name = row.get("name") or row.get("id")
            if not isinstance(name, str):
                continue
            commands.append(
                RuntimeCommand(
                    id=name,
                    title=str(row.get("title") or name),
                    description=row.get("description") if isinstance(row.get("description"), str) else None,
                    scope="session",
                    accepts_args=True,
                    metadata={"source": row.get("source")} if row.get("source") else {},
                )
            )
        return tuple(commands[: max(1, limit)])

    async def execute_command(
        self,
        session_id: str,
        command: str,
        external_session_id: str | None = None,
        raw: str | None = None,
        args: tuple[str, ...] = (),
    ) -> RuntimeCommandResult:
        client = await self._ensure_client()
        external = await self._resolve_external(session_id, external_session_id)
        # The host's `Command.Execute` is `{name, text}` -- both required. Sending
        # `command`/`arguments` was a guess that the service answered 400 to.
        body: dict[str, Any] = {"name": command, "text": raw if raw is not None else " ".join(args)}
        payload = await client.post(f"/api/session/{external}/command", body)
        return RuntimeCommandResult(
            command=command,
            ok=True,
            code="executed",
            result=payload if isinstance(payload, Mapping) else {"result": payload},
        )

    # ----------------------------------------------------------------- writes

    async def create_and_start_session(
        self,
        session_id: str,
        content: str,
        title: str | None = None,
        cwd: str | None = None,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[Any, ...] = (),
        client_message_id: str | None = None,
        runtime_options: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        if attachments:
            return RuntimeOperationResult(ok=False, code="unsupported", message="attachments are not supported yet")
        client = await self._ensure_client()
        body: dict[str, Any] = {"title": title or (content[:40] or "Agents Anywhere")}
        # One service can serve several locations, and `POST /api/session` defaults
        # to the host's own; without this the new session lands outside the
        # inventory this instance reads and vanishes from the UI.
        directory = self._resolved_directory or self.directory
        if directory:
            body["location"] = {"directory": directory}
        # `parentID` is not a field of the create body at all, so a child session
        # cannot be requested here; the host's own subagents show up on their own.
        pending = dict(selections or {})
        agent = pending.pop("agent", None)
        model = pending.pop("model", None)
        if isinstance(agent, str) and agent:
            body["agent"] = agent
        if isinstance(model, str) and model:
            body["model"] = _model_ref(model)
        created = await client.post("/api/session", body)
        rows = _rows(created)
        external = (rows[0].get("id") if rows and isinstance(rows[0], Mapping) else created.get("id") if isinstance(created, Mapping) else None)
        if not isinstance(external, str):
            raise RuntimeUpstreamError("the host did not return the created session id")
        if self._resolved_directory is None:
            # Creating a session makes the host load its location and report the
            # spelling it uses, which is what the case-sensitive `?directory=`
            # filter needs from then on.
            location = created.get("location") if isinstance(created, Mapping) else None
            spelling = location.get("directory") if isinstance(location, Mapping) else None
            if isinstance(spelling, str) and spelling:
                self._resolved_directory = spelling
        platform_id = mappers.platform_session_id(self.host.session_namespace, external)
        self._external_by_session[platform_id] = external
        if pending:
            await self._apply_selections(client, external, pending)
        turn = await self._prompt(client, external, content, client_message_id)
        return RuntimeOperationResult(
            ok=True,
            code="created",
            result={**turn.result, "sessionId": platform_id, "externalSessionId": external},
        )

    async def start_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        selections: Mapping[str, str | None] | None = None,
        attachments: tuple[Any, ...] = (),
        client_message_id: str | None = None,
        cwd: str | None = None,
    ) -> RuntimeOperationResult:
        if attachments:
            return RuntimeOperationResult(ok=False, code="unsupported", message="attachments are not supported yet")
        client = await self._ensure_client()
        external = await self._resolve_external(session_id, external_session_id)
        await self._apply_selections(client, external, selections)
        return await self._prompt(client, external, content, client_message_id)

    async def steer_turn(
        self,
        session_id: str,
        external_session_id: str | None,
        content: str,
        attachments: tuple[Any, ...] = (),
        client_message_id: str | None = None,
    ) -> RuntimeOperationResult:
        raise RuntimeUnsupportedError("the OpenCode host service exposes no steer operation")

    async def interrupt_session(self, session_id: str, reason: str | None = None) -> RuntimeOperationResult:
        client = await self._ensure_client()
        external = await self._resolve_external(session_id, None)
        # Declared with no request body; the answer is `{interrupted: boolean}`.
        # Nothing-running is a benign no-op, so it follows the shape Claude's
        # interrupt already reports rather than being dressed up as a failure.
        payload = await client.post(f"/api/session/{external}/interrupt")
        interrupted = payload.get("interrupted") if isinstance(payload, Mapping) else None
        return RuntimeOperationResult(
            ok=True,
            result={
                "externalSessionId": external,
                "interrupted": bool(interrupted),
                "alreadyStopped": not bool(interrupted),
            },
        )

    async def update_session_selections(
        self, session_id: str, external_session_id: str | None, selections: Mapping[str, str | None]
    ) -> RuntimeOperationResult:
        client = await self._ensure_client()
        external = await self._resolve_external(session_id, external_session_id)
        applied = await self._apply_selections(client, external, selections)
        return RuntimeOperationResult(ok=True, code="updated", result={"applied": applied})

    async def respond_interaction(
        self,
        session_id: str,
        notice_id: str,
        action_id: str,
        input_data: Mapping[str, Any] | None = None,
    ) -> RuntimeOperationResult:
        if action_id == PERSISTENT_ACTION:
            return _refuse(notice_id, "the persistent answer is never accepted remotely")
        if action_id not in (REMOTE_ALLOW_ACTION, REMOTE_DENY_ACTION):
            return _refuse(notice_id, f"unsupported action: {action_id}")
        client = await self._ensure_client()
        external = await self._resolve_external(session_id, None)
        notices = await self.get_session_notices(session_id, external)
        notice = next((item for item in notices if item.notice_id == notice_id), None)
        if notice is None:
            return _refuse(notice_id, "unknown or already-answered permission request")
        if not any(item.get("actionId") == action_id for item in notice.actions):
            return _refuse(notice_id, "this action needs confirmation inside OpenCode")
        decision = "once" if action_id == REMOTE_ALLOW_ACTION else "reject"
        await client.post(f"/api/session/{external}/permission/{notice_id}/reply", {"decision": decision})
        return RuntimeOperationResult(ok=True, code="answered", result={"decision": decision})

    # ------------------------------------------------------------------ helpers

    async def _ensure_client(self) -> OpenCodeServerClient:
        if self._client is None:
            if self._restart_exhausted:
                raise OpenCodeServiceUnavailable(
                    "attach attempts exhausted; restart this runtime to retry"
                )
            await self._attach()
        client = self._client
        if client is None:
            raise OpenCodeServiceUnavailable("not attached to an OpenCode service")
        if self._registration_moved():
            # The host re-registers under a new pid and url when OpenCode restarts.
            # Staying on the old client turned every later read into a connection
            # failure against a process that no longer exists.
            try:
                await self._attach()
            except OpenCodeServiceUnavailable:
                raise
            client = self._client or client
        if self.directory and self._resolved_directory is None:
            # The host opens and closes locations as it works, so a location that
            # happened to be closed at attach time must not stay invisible for the
            # rest of the instance's life: retry, cheaply, on every read.
            with suppress(OpenCodeServiceError, OpenCodeServiceUnavailable, OSError, ValueError):
                self._resolved_directory = await self._resolve_directory(client)
        return client

    def _registration_moved(self) -> bool:
        """True when `service.json` now points somewhere other than our client."""
        attached = self._attached_service
        if attached is None:
            return False
        try:
            current = self._service_reader()
        except OSError:
            return False
        return current is not None and (current.pid != attached.pid or current.url != attached.url)

    def _location_params(self) -> dict[str, str]:
        directory = self._resolved_directory or self.directory
        return {"directory": directory} if directory else {}

    async def _inventory(self, *, force: bool = False) -> tuple[SessionMeta, ...]:
        client = await self._ensure_client()
        # The host's subagents are its own workers, not Agents Anywhere sessions: a
        # Team turn measured 19 rows in this location, 15 of them children, and the
        # parent timeline already carries a `<subagent …>` marker naming each child.
        # Ask for top-level sessions only, then drop any row that still reports a
        # parent -- this host is documented to ignore query filters it accepts
        # (`?directory=` on every catalog), so the filter is intent, not proof.
        rows = await client.list_sessions(
            limit=DEFAULT_PAGE_SIZE, parent_id="null", **self._location_params()
        )
        namespace = self.host.session_namespace
        output: list[SessionMeta] = []
        seen: set[str] = set()
        foreign = 0
        children = 0
        for row in rows:
            if not self._belongs_to_location(row):
                foreign += 1
                continue
            if isinstance(row.get("parentID"), str) and row["parentID"]:
                children += 1
                continue
            meta = mappers.session_meta(row, namespace=namespace)
            if meta.session_id in seen:
                raise RuntimeUpstreamError("OpenCode inventory repeated a session")
            seen.add(meta.session_id)
            self._external_by_session[meta.session_id] = str(meta.external_session_id)
            output.append(meta)
        if children:
            # Routine for a host running a Team, so it is not a warning -- but it is
            # recorded, because it explains an inventory smaller than the host's own
            # session table (rev3 ruling 1: never drop a filtered count silently).
            logger.info(
                "OpenCode inventory left out the host's subagent children",
                {"count": children, "location": self._resolved_directory or self.directory},
            )
        if foreign:
            # rev3 ruling 1: `?directory=` is believed only as far as the rows
            # themselves confirm it, and a filtered-out count is reported rather
            # than dropped silently.
            logger.warning(
                "OpenCode inventory dropped rows outside the configured location",
                {"count": foreign, "location": self._resolved_directory or self.directory},
            )
        return tuple(output)

    def _belongs_to_location(self, row: Any) -> bool:
        if not isinstance(row, Mapping):
            return False
        target = self._resolved_directory or self.directory
        if not target:
            return True
        location = row.get("location")
        directory = location.get("directory") if isinstance(location, Mapping) else None
        return isinstance(directory, str) and canonical_path(directory) == canonical_path(target)

    async def _snapshot(self, external: str, limit: int | None = None) -> RuntimeTimelineSnapshot:
        client = await self._ensure_client()
        rows = await client.list_messages(external, limit=limit)
        session_id = mappers.platform_session_id(self.host.session_namespace, external)
        self._external_by_session[session_id] = external
        projection = project_messages(rows, session_id=session_id)
        return RuntimeTimelineSnapshot(
            session_id=session_id,
            external_session_id=external,
            runtime=RUNTIME,
            items=projection.items,
            complete=not bool(limit),
            metadata={
                "source": "service-http",
                "messages": len(rows),
                "skippedMessageTypes": dict(projection.skipped),
            },
        )

    def _external(self, session_id: str) -> str | None:
        return self._external_by_session.get(session_id)

    async def _resolve_external(self, session_id: str, external: str | None) -> str:
        if external:
            self._external_by_session.setdefault(session_id, external)
            return external
        known = self._external(session_id)
        if known:
            return known
        await self._inventory()
        known = self._external(session_id)
        if known:
            return known
        raise RuntimeUpstreamError(f"session {session_id} is not present in the OpenCode service")

    async def _apply_selections(
        self, client: OpenCodeServerClient, external: str, selections: Mapping[str, str | None] | None
    ) -> list[str]:
        applied: list[str] = []
        if not selections:
            return applied
        model = selections.get("model")
        if isinstance(model, str) and model:
            await client.post(f"/api/session/{external}/model", {"model": _model_ref(model)})
            applied.append("model")
        agent = selections.get("agent")
        if isinstance(agent, str) and agent:
            await client.post(f"/api/session/{external}/agent", {"agent": agent})
            applied.append("agent")
        return applied

    async def _prompt(
        self, client: OpenCodeServerClient, external: str, content: str, client_message_id: str | None
    ) -> RuntimeOperationResult:
        body: dict[str, Any] = {"text": content}
        message_id = _host_message_id(client_message_id)
        if message_id:
            body["id"] = message_id
        payload = await client.post(f"/api/session/{external}/prompt", body)
        return RuntimeOperationResult(
            ok=True,
            code="queued",
            result={"externalSessionId": external, "accepted": isinstance(payload, Mapping)},
        )


def _rows(payload: Any) -> list[Any]:
    if isinstance(payload, list):
        return payload
    if isinstance(payload, Mapping):
        for key in ("data", "items", "commands", "models", "agents"):
            if isinstance(payload.get(key), list):
                return list(payload[key])
    return []


def _selections(row: Mapping[str, Any]) -> dict[str, str | None]:
    selections: dict[str, str | None] = {}
    agent = row.get("agent")
    if isinstance(agent, str):
        selections["agent"] = agent
    model = row.get("model")
    if isinstance(model, Mapping):
        model_id = model.get("id")
        provider_id = model.get("providerID")
        if isinstance(model_id, str):
            selections["model"] = f"{provider_id}/{model_id}" if isinstance(provider_id, str) else model_id
    return selections


def _host_message_id(client_message_id: str | None) -> str | None:
    """Put the platform's client message id in the namespace the host accepts.

    `POST …/prompt` refuses any `id` that does not start with `msg_` (measured: a
    bare UUID is a 400 `Expected a string starting with "msg_"`, while `msg_` plus
    anything opaque is stored verbatim). The web and desktop clients already mint
    `msg_<uuid>`; Android mints `opt_<uuid>`, which is why sending from the phone
    failed while the desktop worked. Forwarding the id is still worth it -- it is
    what makes a retried send land once -- so the id is namespaced rather than
    dropped.
    """
    if not client_message_id:
        return None
    return client_message_id if client_message_id.startswith("msg_") else f"msg_{client_message_id}"


def _model_ref(model: str) -> dict[str, str]:
    """`providerID/modelID` -> the host's `Model.Ref`.

    A bare id is refused rather than guessed at: the host really does repeat ids
    across providers (measured: 79 rows, four repeated ids), so picking a
    provider silently would run the wrong model.
    """
    provider_id, slash, model_id = model.partition("/")
    if not slash or not model_id or not provider_id:
        raise RuntimeInvalidRequestError(f"model selection {model!r} must be 'providerID/modelID'")
    return {"id": model_id, "providerID": provider_id}


def _refuse(notice_id: str, message: str) -> RuntimeOperationResult:
    logger.warning("OpenCode approval refused", {"noticeId": notice_id, "reason": message})
    return RuntimeOperationResult(ok=False, code="unsupported", message=message, result={"noticeId": notice_id})
