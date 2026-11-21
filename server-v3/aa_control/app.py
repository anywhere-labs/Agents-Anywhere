from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from loguru import logger
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncEngine

from aa_control.api import auth as auth_api
from aa_control.api import health as health_api
from aa_control.api import mcp as mcp_api
from aa_control.core.config import ControlSettings
from aa_control.core.errors import ControlError
from aa_control.infra.db.engine import create_engine
from aa_control.infra.db.repositories import ControlRepository
from aa_control.infra.push import LoggingPushProvider, PushProvider, PushRetryWorker
from aa_control.infra.redis_store import RedisControlStore
from aa_control.infra.router_pool import MeshCallRouterPool, RouterPoolPort
from aa_control.rpc.control_service import ControlRpcService
from aa_control.services.auth_service import AuthService
from aa_control.services.device_service import DeviceService
from aa_control.services.fanout_service import FanoutService
from aa_control.services.mcp_service import McpService
from aa_control.services.push_service import PushService
from aa_control.services.tunnel_service import TunnelService


def create_app(
    *,
    settings: ControlSettings | None = None,
    engine: AsyncEngine | None = None,
    redis_client: Redis | None = None,
    router_pool: RouterPoolPort | None = None,
    push_provider: PushProvider | None = None,
    start_push_worker: bool = True,
) -> FastAPI:
    cfg = settings or ControlSettings.from_env()
    owns_engine = engine is None
    owns_redis = redis_client is None
    owns_router_pool = router_pool is None

    db_engine = engine or create_engine(cfg.database_url)
    redis_conn = redis_client or Redis.from_url(cfg.redis_url, decode_responses=False)
    redis_store = RedisControlStore(redis_conn, presence_ttl_seconds=cfg.presence_ttl_seconds)
    pool: RouterPoolPort = router_pool if router_pool is not None else MeshCallRouterPool(cfg.routers)
    provider: PushProvider = push_provider or LoggingPushProvider()

    repo = ControlRepository(db_engine)
    auth_service = AuthService(settings=cfg, repo=repo, redis_store=redis_store, router_pool=pool)
    device_service = DeviceService(repo=repo, redis_store=redis_store, router_pool=pool)
    tunnel_service = TunnelService(settings=cfg, repo=repo, redis_store=redis_store, router_pool=pool)
    fanout_service = FanoutService(settings=cfg, repo=repo, redis_store=redis_store, router_pool=pool)
    push_service = PushService(repo=repo, redis_store=redis_store)
    mcp_service = McpService(
        settings=cfg,
        repo=repo,
        redis_store=redis_store,
        router_pool=pool,
        fanout_service=fanout_service,
    )
    control_rpc = ControlRpcService(
        device_service=device_service,
        tunnel_service=tunnel_service,
        fanout_service=fanout_service,
        push_service=push_service,
    )
    push_worker = PushRetryWorker(
        redis_store=redis_store,
        provider=provider,
        max_attempts=cfg.push_max_attempts,
        base_backoff_seconds=cfg.push_base_backoff_seconds,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        push_task: asyncio.Task[None] | None = None
        try:
            control_rpc.bind_loop(asyncio.get_running_loop())
            if isinstance(pool, MeshCallRouterPool):
                await pool.start(control_service=control_rpc)
            if start_push_worker:
                push_task = asyncio.create_task(push_worker.run_forever(), name="aa-control-push-worker")
            logger.info("aa-control-plane started routers={}", pool.router_ids)
            yield
        finally:
            if push_task is not None:
                push_task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await push_task
            if owns_router_pool and isinstance(pool, MeshCallRouterPool):
                await pool.stop()
            if owns_redis:
                await redis_store.close()
            if owns_engine:
                await db_engine.dispose()

    app = FastAPI(title="Agents Anywhere v3 Control Plane", version="3.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(cfg.cors_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(ControlError)
    async def handle_control_error(_request: Request, exc: ControlError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.http_status,
            content={"code": exc.code, "detail": exc.message},
        )

    app.state.settings = cfg
    app.state.engine = db_engine
    app.state.repo = repo
    app.state.redis_store = redis_store
    app.state.router_pool = pool
    app.state.auth_service = auth_service
    app.state.device_service = device_service
    app.state.tunnel_service = tunnel_service
    app.state.fanout_service = fanout_service
    app.state.push_service = push_service
    app.state.mcp_service = mcp_service
    app.state.control_rpc = control_rpc
    app.state.push_worker = push_worker

    app.include_router(health_api.router)
    app.include_router(auth_api.router)
    app.include_router(mcp_api.router)
    return app
