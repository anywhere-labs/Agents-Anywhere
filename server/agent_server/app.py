from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger

from agent_server.api import (
    admin,
    admin_dashboard,
    agents,
    auth,
    client_ws,
    connector_ingress,
    connectors,
    oauth,
    pairing,
    service,
    sessions,
    sessions_fs,
    sessions_terminal,
)
from agent_server.core.api_namespace import API_V2_PREFIX
from agent_server.core.setup_token import SetupToken
from agent_server.core.utc import utc_now
from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.infra.db.migrations import (
    database_schema_version,
    require_current_database,
    upgrade_database,
)
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.infra.redis_coordinator import RedisCoordinator
from agent_server.infra.repositories.facade import Store
from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.infra.terminal_stream_hub import TerminalStreamHub
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.infra.ws_tickets import ClientWsTicketManager
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.device_runtimes import DeviceRuntimeService
from agent_server.services.shell_tasks import ShellTaskManager

CONNECTOR_PRESENCE_SWEEP_SECONDS = 5


async def _connector_presence_watchdog(app: FastAPI) -> None:
    while True:
        await asyncio.sleep(CONNECTOR_PRESENCE_SWEEP_SECONDS)
        stale_connections = await app.state.rpc.expire_stale()
        for connection in stale_connections:
            changed = await app.state.store.set_connector_offline_if_connection(
                connection.connector_id,
                connection_id=connection.connection_id,
            )
            if changed:
                await publish_dashboard_changed(
                    app.state.store,
                    app.state.timeline_broker,
                    connector_id=connection.connector_id,
                    reason="connector.offline",
                )


def create_app(
    db_path: str | Path | None = None,
    *,
    migrate_database: bool | None = None,
    redis_url: str | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        presence_task: asyncio.Task[None] | None = None
        startup_complete = False
        try:
            await require_current_database(app.state.store.engine)
            app.state.database_schema_version = await database_schema_version(
                app.state.store.engine
            )
            await app.state.redis.start()
            await app.state.timeline_broker.start()
            await app.state.terminal_stream_hub.start()
            await app.state.rpc.start()
            if not app.state.redis.distributed:
                await app.state.store.set_all_connectors_offline()
            presence_task = asyncio.create_task(_connector_presence_watchdog(app))
            # Generate the bootstrap token early so operators see it in logs.
            if await app.state.store.count_users() == 0:
                app.state.setup_token.snapshot()
            startup_complete = True
            yield
        finally:
            if presence_task is not None:
                presence_task.cancel()
                try:
                    await presence_task
                except asyncio.CancelledError:
                    pass
            try:
                released_connections = await app.state.rpc.close()
                if startup_complete:
                    for connection in released_connections:
                        await app.state.store.set_connector_offline_if_connection(
                            connection.connector_id,
                            connection_id=connection.connection_id,
                        )
            finally:
                try:
                    await app.state.terminal_stream_hub.close()
                finally:
                    try:
                        await app.state.timeline_broker.close()
                    finally:
                        try:
                            await app.state.redis.close()
                        finally:
                            if startup_complete and not app.state.redis.distributed:
                                await app.state.store.set_all_connectors_offline()
                            await app.state.store.close()

    app = FastAPI(title="Agent Server", version="0.1.7.2", lifespan=lifespan)
    cors_origins = os.environ.get("AGENT_SERVER_CORS_ORIGINS")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins.split(",") if cors_origins else [],
        allow_origin_regex=os.environ.get(
            "AGENT_SERVER_CORS_ORIGIN_REGEX",
            r"^http://(127\.0\.0\.1|localhost):\d+$",
        ),
        allow_methods=["*"],
        allow_headers=["*"],
    )
    resolved_db_path = db_path or os.environ.get("AGENT_SERVER_DB")
    should_migrate = (
        db_path is not None if migrate_database is None else migrate_database
    )
    if should_migrate:
        upgrade_database(sqlite_path=resolved_db_path)
    app.state.store = Store(resolved_db_path)
    app.state.database_schema_version = "unknown"
    resolved_redis_url = redis_url
    if resolved_redis_url is None and db_path is None:
        resolved_redis_url = os.environ.get("AGENT_SERVER_REDIS_URL")
    app.state.redis = RedisCoordinator(
        resolved_redis_url,
        prefix=os.environ.get("AGENT_SERVER_REDIS_PREFIX", "agents-anywhere"),
    )
    app.state.rpc = ConnectorRpcManager(
        app.state.redis,
        instance_id=os.environ.get("AGENT_SERVER_INSTANCE_ID"),
    )
    app.state.fs_downloads = FsDownloadRelayManager(app.state.redis)
    app.state.shell_tasks = ShellTaskManager(app.state.redis)
    app.state.terminal_broker = TerminalBroker()
    app.state.terminal_stream_hub = TerminalStreamHub(app.state.redis)
    app.state.timeline_broker = TimelineBroker(app.state.redis)
    app.state.device_runtime_service = DeviceRuntimeService(
        app.state.store,
        app.state.rpc,
        app.state.timeline_broker,
        app.state.redis,
    )
    app.state.ws_tickets = ClientWsTicketManager(app.state.redis)
    app.state.setup_token = SetupToken()
    app.state.started_at_iso = utc_now()
    app.state.started_at_monotonic = time.monotonic()

    @app.get(f"{API_V2_PREFIX}/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "serverTime": utc_now()}

    app.include_router(auth.router, prefix=API_V2_PREFIX)
    app.include_router(admin.router, prefix=API_V2_PREFIX)
    app.include_router(admin_dashboard.router, prefix=API_V2_PREFIX)
    app.include_router(service.router, prefix=API_V2_PREFIX)
    app.include_router(oauth.router, prefix=API_V2_PREFIX)
    app.include_router(connectors.router, prefix=API_V2_PREFIX)
    app.include_router(client_ws.router, prefix=API_V2_PREFIX)
    app.include_router(connector_ingress.router, prefix=API_V2_PREFIX)
    app.include_router(agents.router, prefix=API_V2_PREFIX)
    app.include_router(pairing.router, prefix=API_V2_PREFIX)
    app.include_router(sessions.router, prefix=API_V2_PREFIX)
    app.include_router(sessions_fs.router, prefix=API_V2_PREFIX)
    app.include_router(sessions_terminal.router, prefix=API_V2_PREFIX)

    static_dir = os.environ.get("AGENT_SERVER_STATIC_DIR")
    if static_dir:
        static_path = Path(static_dir)
        if not static_path.is_dir():
            raise RuntimeError(f"AGENT_SERVER_STATIC_DIR does not exist: {static_path}")
        logger.info("serving web static files from {}", static_path)
        for mount_name in ("_next", "assets", "brand"):
            mount_path = static_path / mount_name
            if mount_path.is_dir():
                app.mount(
                    f"/{mount_name}",
                    StaticFiles(directory=mount_path),
                    name=f"web-{mount_name}",
                )

        def _static_index(path: str = "") -> FileResponse:
            relative = path.strip("/")
            default_locale = os.environ.get("AGENT_SERVER_STATIC_DEFAULT_LOCALE", "en")
            if relative:
                candidate = static_path / relative
                if candidate.is_dir() and (candidate / "index.html").is_file():
                    return FileResponse(candidate / "index.html")
                if candidate.is_file():
                    return FileResponse(candidate)
                html_candidate = static_path / f"{relative}.html"
                if html_candidate.is_file():
                    return FileResponse(html_candidate)
                default_locale_candidate = static_path / default_locale / relative
                if (
                    default_locale_candidate.is_dir()
                    and (default_locale_candidate / "index.html").is_file()
                ):
                    return FileResponse(default_locale_candidate / "index.html")

            default_index = static_path / default_locale / "index.html"
            if default_index.is_file():
                return FileResponse(default_index)
            return FileResponse(static_path / "index.html")

        @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
        def web_index() -> FileResponse:
            return _static_index()

        @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
        def web_static(path: str) -> FileResponse:
            return _static_index(path)

    return app


def main() -> None:
    uvicorn.run(
        "agent_server.app:create_app",
        factory=True,
        host="127.0.0.1",
        port=8000,
        reload=False,
    )
