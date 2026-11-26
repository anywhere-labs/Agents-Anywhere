from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from aa_control.core.utc import utc_now_iso
from aa_control.infra.db.engine import check_database_health

router = APIRouter(tags=["health"])


@router.get("/healthz")
async def healthz() -> dict:
    return {"ok": True, "service": "aa-control-plane", "server_time": utc_now_iso()}


@router.get("/readyz")
async def readyz(request: Request) -> JSONResponse:
    db_ok = await check_database_health(request.app.state.engine)
    redis_ok = await request.app.state.redis_store.ping()
    routers_ok = await request.app.state.router_pool.health()
    ready = db_ok and redis_ok and routers_ok
    payload = {
        "ok": ready,
        "checks": {
            "postgres": db_ok,
            "redis": redis_ok,
            "meshcall_routers": routers_ok,
        },
        # Informational only: an unconfigured push platform is skipped, not a readiness failure.
        "push": request.app.state.push_status,
        "server_time": utc_now_iso(),
    }
    return JSONResponse(status_code=200 if ready else 503, content=payload)
