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

from aa_control.api import assistant as assistant_api
from aa_control.api import auth as auth_api
from aa_control.api import drive as drive_api
from aa_control.api import health as health_api
from aa_control.api import mcp as mcp_api
from aa_control.core.config import ControlSettings
from aa_control.core.errors import ControlError
from aa_control.infra.db.engine import create_engine
from aa_control.infra.db.repositories import ControlRepository
from aa_control.infra.object_store import DriveCleanupWorker, ObjectStorePort, S3ObjectStore
from aa_control.infra.oidc import OidcJwksVerifier, OidcVerifierPort
from aa_control.infra.push import (
    PlatformPushProvider,
    PushProvider,
    PushRetryWorker,
    build_push_provider,
)
from aa_control.infra.redis_store import RedisControlStore
from aa_control.infra.router_pool import MeshCallRouterPool, RouterPoolPort
from aa_control.infra.tokens_client import HttpTokensAnywhereClient, TokensAnywhereClientPort
from aa_control.rpc.control_service import ControlRpcService
from aa_control.services.assistant_service import AssistantService
from aa_control.services.auth_service import AuthService
from aa_control.services.device_service import DeviceService
from aa_control.services.drive_service import DriveService
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
    oidc_verifier: OidcVerifierPort | None = None,
    object_store: ObjectStorePort | None = None,
    tokens_client: TokensAnywhereClientPort | None = None,
    start_push_worker: bool = True,
    start_drive_cleanup_worker: bool | None = None,
) -> FastAPI:
    cfg = settings or ControlSettings.from_env()
    owns_engine = engine is None
    owns_redis = redis_client is None
    owns_router_pool = router_pool is None
    owns_oidc_verifier = False
    owns_object_store = False
    owns_tokens_client = tokens_client is None

    verifier: OidcVerifierPort | None = oidc_verifier
    if cfg.auth_mode == "oidc" and verifier is None:
        assert cfg.oidc_auth is not None
        verifier = OidcJwksVerifier(
            config=cfg.oidc_auth,
            default_entitlements=cfg.default_entitlements,
        )
        owns_oidc_verifier = True

    store: ObjectStorePort | None = object_store
    if store is None and cfg.drive.s3 is not None:
        store = S3ObjectStore(cfg.drive.s3)
        owns_object_store = True

    tc: TokensAnywhereClientPort = tokens_client or HttpTokensAnywhereClient(cfg.assistant.tokens)

    db_engine = engine or create_engine(cfg.database_url)
    redis_conn = redis_client or Redis.from_url(cfg.redis_url, decode_responses=False)
    redis_store = RedisControlStore(redis_conn, presence_ttl_seconds=cfg.presence_ttl_seconds)
    pool: RouterPoolPort = router_pool if router_pool is not None else MeshCallRouterPool(cfg.routers)
    owns_push_provider = push_provider is None
    provider: PushProvider = push_provider if push_provider is not None else build_push_provider(cfg.push)

    repo = ControlRepository(db_engine)
    auth_service = AuthService(
        settings=cfg,
        repo=repo,
        redis_store=redis_store,
        router_pool=pool,
        oidc_verifier=verifier,
    )
    device_service = DeviceService(repo=repo, redis_store=redis_store, router_pool=pool)
    drive_service = DriveService(
        settings=cfg,
        repo=repo,
        redis_store=redis_store,
        object_store=store,
    )
    assistant_service = AssistantService(
        settings=cfg,
        repo=repo,
        redis_store=redis_store,
        tokens_client=tc,
        drive_service=drive_service,
    )
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
        token_store=repo,
        max_attempts=cfg.push_max_attempts,
        base_backoff_seconds=cfg.push_base_backoff_seconds,
    )
    push_status = provider.status() if isinstance(provider, PlatformPushProvider) else {"provider": "custom"}
    drive_cleanup_worker = DriveCleanupWorker(
        sweep_fn=drive_service.cleanup_expired,
        interval_seconds=cfg.drive.cleanup_interval_seconds,
    )
    run_drive_cleanup = (
        start_drive_cleanup_worker if start_drive_cleanup_worker is not None else (start_push_worker and store is not None)
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        push_task: asyncio.Task[None] | None = None
        cleanup_task: asyncio.Task[None] | None = None
        try:
            control_rpc.bind_loop(asyncio.get_running_loop())
            if isinstance(pool, MeshCallRouterPool):
                await pool.start(control_service=control_rpc)
            if start_push_worker:
                push_task = asyncio.create_task(push_worker.run_forever(), name="aa-control-push-worker")
            if run_drive_cleanup:
                cleanup_task = asyncio.create_task(
                    drive_cleanup_worker.run_forever(),
                    name="aa-control-drive-cleanup-worker",
                )
            logger.info(
                "aa-control-plane started routers={} drive_enabled={} push={}",
                pool.router_ids,
                drive_service.enabled,
                push_status,
            )
            yield
        finally:
            for bg_task in (push_task, cleanup_task):
                if bg_task is not None:
                    bg_task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await bg_task
            if owns_router_pool and isinstance(pool, MeshCallRouterPool):
                await pool.stop()
            if owns_oidc_verifier and verifier is not None:
                await verifier.close()
            if owns_object_store and store is not None:
                await store.close()
            if owns_tokens_client:
                await tc.close()
            if owns_push_provider and isinstance(provider, PlatformPushProvider):
                await provider.close()
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
    app.state.oidc_verifier = verifier
    app.state.object_store = store
    app.state.tokens_client = tc
    app.state.auth_service = auth_service
    app.state.device_service = device_service
    app.state.drive_service = drive_service
    app.state.assistant_service = assistant_service
    app.state.tunnel_service = tunnel_service
    app.state.fanout_service = fanout_service
    app.state.push_service = push_service
    app.state.mcp_service = mcp_service
    app.state.control_rpc = control_rpc
    app.state.push_worker = push_worker
    app.state.push_provider = provider
    app.state.push_status = push_status
    app.state.drive_cleanup_worker = drive_cleanup_worker

    app.include_router(health_api.router)
    app.include_router(auth_api.router)
    app.include_router(drive_api.router)
    app.include_router(assistant_api.router)
    app.include_router(mcp_api.router)
    return app
