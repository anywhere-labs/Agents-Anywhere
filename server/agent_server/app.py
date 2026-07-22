from __future__ import annotations

import os
import time
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger

from agent_server.infra.connector_rpc import ConnectorRpcManager
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
    sessions,
    sessions_fs,
    sessions_terminal,
    service,
)
from agent_server.core.setup_token import SetupToken
from agent_server.core.api_namespace import API_V2_PREFIX
from agent_server.services.shell_tasks import ShellTaskManager
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.services.device_runtimes import DeviceRuntimeService
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.infra.repositories.facade import Store
from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.infra.terminal_stream_hub import TerminalStreamHub
from agent_server.core.utc import utc_now
from agent_server.infra.timeline_broker import TimelineBroker
from agent_server.infra.ws_tickets import ClientWsTicketManager


CONNECTOR_PRESENCE_SWEEP_SECONDS = 5


async def _connector_presence_watchdog(app: FastAPI) -> None:
    while True:
        await asyncio.sleep(CONNECTOR_PRESENCE_SWEEP_SECONDS)
        stale_connections = app.state.rpc.expire_stale()
        for connection in stale_connections:
            await app.state.store.set_connector_status(connection.connector_id, "offline")
            await publish_dashboard_changed(
                app.state.store,
                app.state.timeline_broker,
                connector_id=connection.connector_id,
                reason="connector.offline",
            )


def create_app(db_path: str | Path | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        await app.state.store.init_schema()
        await app.state.store.set_all_connectors_offline()
        presence_task = asyncio.create_task(_connector_presence_watchdog(app))
        # If the user table is empty, eagerly generate + log the bootstrap
        # token so the operator sees it on startup. Otherwise stay dormant;
        # the token instance only generates one when /api/v2/auth/* asks for it.
        if await app.state.store.count_users() == 0:
            app.state.setup_token.snapshot()
        try:
            yield
        finally:
            presence_task.cancel()
            try:
                await presence_task
            except asyncio.CancelledError:
                pass
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
    app.state.store = Store(db_path or os.environ.get("AGENT_SERVER_DB"))
    app.state.rpc = ConnectorRpcManager()
    app.state.fs_downloads = FsDownloadRelayManager()
    app.state.shell_tasks = ShellTaskManager()
    app.state.terminal_broker = TerminalBroker()
    app.state.terminal_stream_hub = TerminalStreamHub()
    app.state.timeline_broker = TimelineBroker()
    app.state.device_runtime_service = DeviceRuntimeService(
        app.state.store,
        app.state.rpc,
        app.state.timeline_broker,
    )
    app.state.ws_tickets = ClientWsTicketManager()
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
                app.mount(f"/{mount_name}", StaticFiles(directory=mount_path), name=f"web-{mount_name}")

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
                if default_locale_candidate.is_dir() and (default_locale_candidate / "index.html").is_file():
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
