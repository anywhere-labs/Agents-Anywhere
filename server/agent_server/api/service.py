from __future__ import annotations

import time
from urllib.parse import urlunsplit

from fastapi import APIRouter, Depends, Request

from agent_server.deps import get_store, require_admin
from agent_server.core.models import ServiceInfoResponse
from agent_server.infra.repositories.facade import Store
from agent_server.core.utc import utc_now


router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/service", response_model=ServiceInfoResponse)
async def service_info(
    request: Request,
    db: Store = Depends(get_store),
) -> ServiceInfoResponse:
    app = request.app
    started_at_monotonic: float | None = getattr(app.state, "started_at_monotonic", None)
    started_at_iso: str = getattr(app.state, "started_at_iso", utc_now())
    if started_at_monotonic is not None:
        uptime = max(0, int(time.monotonic() - started_at_monotonic))
    else:
        uptime = 0

    endpoint = _public_endpoint(request)
    version = app.version or "0.0.0"

    backend_name = db.backend
    database_label = "SQLite" if backend_name == "sqlite" else "PostgreSQL"
    database_path = _database_display_path(db)

    return ServiceInfoResponse(
        endpoint=endpoint,
        version=version,
        database=database_label,
        databasePath=database_path,
        startedAt=started_at_iso,
        uptimeSeconds=uptime,
        serverTime=utc_now(),
    )


def _public_endpoint(request: Request) -> str:
    # Honour reverse-proxy hints (set by trusted proxies); fall back to the
    # request URL. Keep it origin-only — no path component.
    forwarded_proto = request.headers.get("x-forwarded-proto")
    forwarded_host = request.headers.get("x-forwarded-host")
    scheme = forwarded_proto or request.url.scheme
    host = forwarded_host or request.url.netloc
    return urlunsplit((scheme, host, "", "", ""))


def _database_display_path(db: Store) -> str | None:
    url = db.engine.url
    if db.backend == "sqlite":
        return url.database or None
    # For non-sqlite, expose host:port/dbname without credentials.
    host = url.host or "?"
    port = f":{url.port}" if url.port else ""
    name = url.database or "?"
    return f"{host}{port}/{name}"
