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

from agent_server.infra.connector_rpc import ConnectorRpcManager
from agent_server.api import (
    admin,
    agents,
    approvals,
    auth,
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
from agent_server.services.shell_tasks import ShellTaskManager
from agent_server.services.dashboard_events import publish_dashboard_changed
from agent_server.infra.fs_downloads import FsDownloadRelayManager
from agent_server.infra.repositories.facade import Store
from agent_server.infra.terminal_broker import TerminalBroker
from agent_server.core.utc import utc_now
from agent_server.infra.timeline_broker import TimelineBroker


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
        # token so the operator sees it on startup. Otherwise stay dormant —
        # the token instance only generates one when /auth/* asks for it.
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

    app = FastAPI(title="Agent Server", version="0.1.0", lifespan=lifespan)
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
    app.state.timeline_broker = TimelineBroker()
    app.state.setup_token = SetupToken()
    app.state.started_at_iso = utc_now()
    app.state.started_at_monotonic = time.monotonic()

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "serverTime": utc_now()}

    app.include_router(auth.router)
    app.include_router(admin.router)
    app.include_router(service.router)
    app.include_router(oauth.router)
    app.include_router(connectors.router)
    app.include_router(connector_ingress.router)
    app.include_router(agents.router)
    app.include_router(pairing.router)
    app.include_router(sessions.router)
    app.include_router(sessions_fs.router)
    app.include_router(sessions_terminal.router)
    app.include_router(approvals.router)

    static_dir = os.environ.get("AGENT_SERVER_STATIC_DIR")
    if static_dir:
        static_path = Path(static_dir)
        if not static_path.is_dir():
            raise RuntimeError(f"AGENT_SERVER_STATIC_DIR does not exist: {static_path}")
        app.mount("/assets", StaticFiles(directory=static_path / "assets"), name="web-assets")

        @app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
        def web_index() -> FileResponse:
            return FileResponse(static_path / "index.html")

    return app

# this is a comment
def main() -> None:
    uvicorn.run(
        "agent_server.app:create_app",
        factory=True,
        host="127.0.0.1",
        port=8000,
        reload=False,
    )
