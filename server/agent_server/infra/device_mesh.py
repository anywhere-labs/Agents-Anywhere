"""Per-worker MeshCall client for v3 devices (``contracts/device-meshcall/1.0``).

Every Server worker is a client of the single MeshCall Router (account
``aa-server``) and calls ``aa.device.v1.*`` on any device directly, by
``instance_id = deviceId``. The connection is lazy and reconnects; the Router
being down never stops the Server from starting (#441 review): calls fail as
"not delivered" and readiness reports ``checks.mesh = error``.

Every failure is classified with ``classify_mesh_error`` into not delivered
(offline semantics), outcome unknown (never reported as offline, never retried
automatically) or an application error from the device.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import secrets
import tempfile
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TypeVar

from loguru import logger
from pydantic import BaseModel

from agent_server.core.device_meshcall import (
    CONNECTION_ID_METADATA,
    MESH_MAX_FRAME_BYTES,
    MESH_SERVICE_PREFIX,
    FailureClass,
    MeshRoute,
    classify_mesh_error,
)

ResponseT = TypeVar("ResponseT", bound=BaseModel)

DEVICE_SERVICES: tuple[str, ...] = tuple(
    f"{MESH_SERVICE_PREFIX}.{name}" for name in ("Link", "Sessions", "Store", "Runtime", "Commands", "Secure")
)
ROUTER_AUTH_SERVICE = "meshcall.router.v1.AuthService"
ROUTER_REGISTRY_SERVICE = "meshcall.router.v1.Registry"
DEFAULT_ROUTER_USER = "aa-server"
DEFAULT_TOKEN_TTL_SECONDS = 900
DEFAULT_READ_TIMEOUT_SECONDS = 10.0
DEFAULT_COMMAND_TIMEOUT_SECONDS = 30.0


class MeshNotConfigured(RuntimeError):
    """No Router is configured for this Server."""


class DeviceCallError(Exception):
    """A device call failed; ``failure`` decides how the Server reports it."""

    def __init__(
        self,
        failure: FailureClass,
        code: str,
        message: str = "",
        *,
        reason: str | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message or code)
        self.failure = failure
        self.code = code
        self.reason = reason
        self.message = message
        self.details = dict(details or {})

    @property
    def not_delivered(self) -> bool:
        return self.failure == "not_delivered"

    @property
    def outcome_unknown(self) -> bool:
        return self.failure == "outcome_unknown"

    def __repr__(self) -> str:
        return f"DeviceCallError({self.failure}, {self.code}, reason={self.reason})"


@dataclass(frozen=True)
class MeshSettings:
    """``AGENT_SERVER_MESH_*``; ``router_url`` empty means the feature is off."""

    router_url: str = ""
    username: str = DEFAULT_ROUTER_USER
    password: str = ""
    public_url: str = ""
    token_ttl_seconds: int = DEFAULT_TOKEN_TTL_SECONDS
    read_timeout_seconds: float = DEFAULT_READ_TIMEOUT_SECONDS
    command_timeout_seconds: float = DEFAULT_COMMAND_TIMEOUT_SECONDS
    local_router: bool = False
    local_router_binary: str = ""
    extra_router_args: tuple[str, ...] = field(default_factory=tuple)

    @property
    def configured(self) -> bool:
        return bool(self.router_url) or self.local_router

    @classmethod
    def from_environment(cls, environ: Mapping[str, str] | None = None) -> MeshSettings:
        env = os.environ if environ is None else environ
        password = env.get("AGENT_SERVER_MESH_PASSWORD", "").strip()
        password_file = env.get("AGENT_SERVER_MESH_PASSWORD_FILE", "").strip()
        if not password and password_file:
            try:
                password = Path(password_file).read_text().strip()
            except OSError as exc:
                logger.warning("cannot read AGENT_SERVER_MESH_PASSWORD_FILE {}: {}", password_file, exc)
        local = env.get("AGENT_SERVER_MESH_LOCAL_ROUTER", "").strip().lower() in {"1", "true", "yes"}
        return cls(
            router_url=env.get("AGENT_SERVER_MESH_ROUTER_URL", "").strip(),
            username=env.get("AGENT_SERVER_MESH_USERNAME", DEFAULT_ROUTER_USER).strip() or DEFAULT_ROUTER_USER,
            password=password,
            public_url=env.get("AGENT_SERVER_MESH_PUBLIC_URL", "").strip(),
            token_ttl_seconds=int(env.get("AGENT_SERVER_MESH_TOKEN_TTL_SECONDS", str(DEFAULT_TOKEN_TTL_SECONDS))),
            read_timeout_seconds=float(
                env.get("AGENT_SERVER_DEVICE_READ_TIMEOUT_SECONDS", str(DEFAULT_READ_TIMEOUT_SECONDS))
            ),
            command_timeout_seconds=float(
                env.get("AGENT_SERVER_DEVICE_COMMAND_TIMEOUT_SECONDS", str(DEFAULT_COMMAND_TIMEOUT_SECONDS))
            ),
            local_router=local,
            local_router_binary=env.get("MESHCALL_ROUTER_BINARY", "").strip(),
        )


def router_password_hash(password: str, *, salt: bytes | None = None, iterations: int = 600_000) -> str:
    """The Router auth-file hash (``pbkdf2-sha256$iterations$salt$key``)."""

    salt = salt or secrets.token_bytes(16)
    key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations)
    return f"pbkdf2-sha256${iterations}${salt.hex()}${key.hex()}"


def router_auth_document(password_hash: str, *, username: str = DEFAULT_ROUTER_USER) -> dict[str, Any]:
    """The Router auth file: one account that calls devices and issues their tokens."""

    return {
        "users": [
            {
                "username": username,
                "password_hash": password_hash,
                "roles": ["client", "server"],
                # Delegation: the account may only issue tokens for services it may register.
                "register": list(DEVICE_SERVICES),
                "call": [
                    *(f"{name}/*" for name in DEVICE_SERVICES),
                    f"{ROUTER_AUTH_SERVICE}/issue_token",
                    f"{ROUTER_AUTH_SERVICE}/revoke_token",
                    f"{ROUTER_AUTH_SERVICE}/renew_token",
                    f"{ROUTER_AUTH_SERVICE}/list_tokens",
                    f"{ROUTER_AUTH_SERVICE}/whoami",
                    f"{ROUTER_REGISTRY_SERVICE}/*",
                ],
            }
        ]
    }


@dataclass(frozen=True)
class DeviceToken:
    token: str
    token_id: str
    expires_at_ms: int
    services: tuple[str, ...]


class DeviceMesh:
    """The worker's MeshCall client: lazy, reconnecting, never blocks startup."""

    def __init__(self, settings: MeshSettings | None = None) -> None:
        self.settings = settings or MeshSettings.from_environment()
        self._mesh: Any | None = None
        self._lock = asyncio.Lock()
        self._local_router: Any | None = None
        self._router_url = self.settings.router_url
        self._password = self.settings.password
        self._closed = False
        self.last_error: str | None = None

    @property
    def configured(self) -> bool:
        return self.settings.configured

    @property
    def router_url(self) -> str:
        return self._router_url

    async def start(self) -> None:
        """Start the dev ``LocalRouter`` if asked to; never raises."""

        if not self.settings.local_router or self._local_router is not None:
            return
        try:
            await self._start_local_router()
        except Exception as exc:  # noqa: BLE001 - the Router must not block startup
            self.last_error = f"local router failed: {exc}"
            logger.warning("device mesh local router did not start: {}", exc)

    async def _start_local_router(self) -> None:
        from meshcall import LocalRouter

        self._password = self._password or secrets.token_urlsafe(24)
        directory = Path(tempfile.mkdtemp(prefix="aa-local-router-"))
        auth_file = directory / "router-auth.json"
        auth_file.write_text(
            json.dumps(router_auth_document(router_password_hash(self._password), username=self.settings.username))
        )
        kwargs: dict[str, Any] = {}
        if self.settings.local_router_binary:
            kwargs["binary_path"] = self.settings.local_router_binary
        router = LocalRouter(port=0, auth_file=auth_file, max_frame_size=MESH_MAX_FRAME_BYTES, **kwargs)
        await router.start()
        self._local_router = router
        self._router_url = router.url
        logger.info("device mesh local router listening url={}", router.url)

    async def close(self) -> None:
        self._closed = True
        async with self._lock:
            mesh, self._mesh = self._mesh, None
        if mesh is not None:
            with contextlib.suppress(Exception):
                await mesh.close()
        if self._local_router is not None:
            router, self._local_router = self._local_router, None
            with contextlib.suppress(Exception):
                await router.stop()

    async def _get(self) -> Any:
        if not self.configured:
            raise MeshNotConfigured("AGENT_SERVER_MESH_ROUTER_URL is not set")
        if not self._router_url:
            raise DeviceCallError("not_delivered", "unavailable", "local router is not running", reason="router_down")
        async with self._lock:
            if self._mesh is None:
                from meshcall import (
                    Mesh,
                    ReconnectPolicy,
                    RetryPolicy,
                    Router,
                    RouterCredentials,
                )

                self._mesh = Mesh(
                    Router(self._router_url),
                    credentials=RouterCredentials.basic(self.settings.username, self._password),
                    peer_id=f"aa-server-{os.getpid()}",
                    # AA classifies failures itself; the SDK must not retry or wait out long backoffs.
                    retry=RetryPolicy(enabled=False),
                    reconnect=ReconnectPolicy(initial_delay=0.2, max_delay=2.0, max_attempts=2),
                    max_frame_size=MESH_MAX_FRAME_BYTES,
                )
            return self._mesh

    async def _reset(self, mesh: Any, exc: BaseException) -> None:
        from meshcall import MeshCallError

        code = getattr(exc, "code", None) if isinstance(exc, MeshCallError) else None
        if code not in (None, "unavailable", "unauthenticated"):
            return
        async with self._lock:
            if self._mesh is not mesh:
                return
            self._mesh = None
        with contextlib.suppress(Exception):
            await mesh.close()

    async def _connect(self, timeout: float) -> Any:
        """Connected Mesh, or ``DeviceCallError(not_delivered)``."""

        from meshcall import MeshCallError

        mesh = await self._get()
        try:
            async with asyncio.timeout(timeout):
                await mesh.connect()
        except (TimeoutError, OSError, MeshCallError) as exc:
            self.last_error = str(exc) or type(exc).__name__
            await self._reset(mesh, exc)
            raise DeviceCallError(
                "not_delivered",
                getattr(exc, "code", "unavailable"),
                f"MeshCall Router unavailable: {exc}",
                reason="router_unreachable",
            ) from exc
        self.last_error = None
        return mesh

    # -- health -------------------------------------------------------------

    async def check(self, timeout: float = 2.0) -> dict[str, str]:
        """``/health/ready`` entry; never raises."""

        if not self.configured:
            return {"status": "not_configured"}
        try:
            mesh = await self._connect(timeout)
            async with asyncio.timeout(timeout):
                await mesh.auth.whoami()
            return {"status": "ok"}
        except Exception as exc:  # noqa: BLE001 - readiness reports, never raises
            return {"status": "error", "message": str(exc) or type(exc).__name__}

    # -- Router administration ----------------------------------------------

    async def issue_device_token(
        self,
        device_id: str,
        services: Mapping[str, list[str]] | tuple[str, ...] = DEVICE_SERVICES,
        *,
        ttl_seconds: int | None = None,
    ) -> DeviceToken:
        """A token that may register only ``device_id`` and only ``services``.

        ``services`` is ``{service: [method, …]}`` (``core.device_meshcall.registered_services``,
        the per-mode registration table) or a tuple of whole services.
        """

        from meshcall import RouterScope

        mesh = await self._connect(5)
        methods = services if isinstance(services, Mapping) else {name: [] for name in services}
        scopes = [
            RouterScope(service=name, methods=list(names), register=True, instance_ids=[device_id])
            for name, names in methods.items()
        ]
        try:
            issued = await mesh.auth.issue_token(scopes, ttl_seconds=ttl_seconds or self.settings.token_ttl_seconds)
        except Exception as exc:
            await self._reset(mesh, exc)
            raise self._classify(exc, opened=True) from exc
        return DeviceToken(
            token=issued.token,
            token_id=issued.token_id,
            expires_at_ms=issued.expires_at_unix_ms,
            services=tuple(methods),
        )

    async def revoke_token(self, token_id: str) -> bool:
        """Revoke; the Router closes that token's connections with 4401. Best effort."""

        try:
            mesh = await self._connect(5)
            return bool(await mesh.auth.revoke_token(token_id))
        except Exception as exc:  # noqa: BLE001 - a Router restart already dropped every token
            logger.warning("device mesh token revoke failed token_id={} error={}", token_id, exc)
            return False

    async def registered_services(self, device_id: str) -> set[str]:
        """Which ``aa.device.v1.*`` services ``device_id`` has registered (``Registry.describe``)."""

        mesh = await self._connect(5)
        found: set[str] = set()
        for name in DEVICE_SERVICES:
            try:
                described = await mesh.registry.describe(name)
            except Exception as exc:
                if getattr(exc, "code", None) in ("unavailable",):
                    await self._reset(mesh, exc)
                    raise self._classify(exc, opened=False) from exc
                continue
            if any(instance.id == device_id for instance in described.instances):
                found.add(name)
        return found

    # -- calls ----------------------------------------------------------------

    def _classify(self, exc: BaseException, *, opened: bool) -> DeviceCallError:
        from meshcall import MeshCallError

        if isinstance(exc, DeviceCallError):
            return exc
        if isinstance(exc, MeshCallError):
            reason = exc.reason
            failure = classify_mesh_error(exc.code, reason, opened=opened)
            if reason == "connection_replaced":
                # The device refused a call for an older link generation before running it.
                failure = "not_delivered"
            return DeviceCallError(failure, exc.code, exc.message, reason=reason, details=exc.details)
        if isinstance(exc, TimeoutError):
            return DeviceCallError(
                classify_mesh_error("deadline_exceeded", None, opened=opened), "deadline_exceeded", "timed out"
            )
        if isinstance(exc, (ConnectionError, OSError)):
            return DeviceCallError(
                classify_mesh_error("unavailable", "connection_lost", opened=opened),
                "unavailable",
                str(exc),
                reason="connection_lost",
            )
        raise exc

    @staticmethod
    def _metadata(connection_id: str | None) -> dict[str, str] | None:
        return {CONNECTION_ID_METADATA: connection_id} if connection_id else None

    async def unary(
        self,
        device_id: str,
        route: MeshRoute,
        request: BaseModel,
        response_type: type[ResponseT],
        *,
        connection_id: str | None = None,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> ResponseT:
        timeout = timeout or self.settings.read_timeout_seconds
        mesh = await self._connect(min(timeout, 5))
        try:
            return await mesh.call_unary(
                route.service,
                route.method,
                request,
                response_type,
                instance=device_id,
                timeout=timeout,
                metadata=self._metadata(connection_id),
                idempotency_key=idempotency_key,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            await self._reset(mesh, exc)
            raise self._classify(exc, opened=True) from exc

    async def stream(
        self,
        device_id: str,
        route: MeshRoute,
        request: BaseModel,
        item_type: type[ResponseT],
        *,
        connection_id: str | None = None,
        timeout: float | None = None,
        idle_timeout: float | None = None,
    ) -> AsyncIterator[ResponseT]:
        """Server stream; iteration raises ``DeviceCallError``. Closing the iterator cancels the call."""

        mesh = await self._connect(5)
        call = mesh.call_server_stream(
            route.service,
            route.method,
            request,
            item_type,
            instance=device_id,
            timeout=timeout,
            idle_timeout=idle_timeout,
            metadata=self._metadata(connection_id),
        )
        try:
            async for item in call:
                yield item
        except asyncio.CancelledError:
            raise
        except GeneratorExit:
            raise
        except Exception as exc:
            await self._reset(mesh, exc)
            raise self._classify(exc, opened=True) from exc
        finally:
            with contextlib.suppress(Exception):
                await asyncio.shield(call.cancel("caller_closed"))

    async def duplex(
        self,
        device_id: str,
        route: MeshRoute,
        request: BaseModel,
        input_type: type[BaseModel],
        output_type: type[ResponseT],
        *,
        connection_id: str | None = None,
    ) -> Any:
        """Open a duplex call (``Secure/channel``); the caller owns send/iterate/cancel."""

        mesh = await self._connect(5)
        return mesh.call_duplex(
            route.service,
            route.method,
            request,
            input_type,
            output_type,
            instance=device_id,
            metadata=self._metadata(connection_id),
        )

    def classify(self, exc: BaseException, *, opened: bool = True) -> DeviceCallError:
        return self._classify(exc, opened=opened)


def init_router_auth(directory: Path, *, password: str = "", username: str = DEFAULT_ROUTER_USER) -> Path:
    """Write ``router-auth.json`` (and ``aa-server.password`` when generating one) into ``directory``.

    The Compose ``mesh-auth`` step runs this before the Router starts. Without an explicit
    password it keeps the one generated on a previous run, so restarts do not change it.
    """

    directory.mkdir(parents=True, exist_ok=True)
    password_path = directory / "aa-server.password"
    if not password:
        if password_path.exists():
            password = password_path.read_text().strip()
        if not password:
            password = secrets.token_urlsafe(32)
    password_path.write_text(password + "\n")
    password_path.chmod(0o640)
    auth_path = directory / "router-auth.json"
    auth_path.write_text(json.dumps(router_auth_document(router_password_hash(password), username=username), indent=2))
    auth_path.chmod(0o644)
    return auth_path


def main(argv: list[str] | None = None) -> None:
    import argparse

    parser = argparse.ArgumentParser(prog="python -m agent_server.infra.device_mesh")
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init-auth", help="write the MeshCall Router auth file for the aa-server account")
    init.add_argument("--dir", type=Path, required=True)
    init.add_argument("--username", default=os.environ.get("AGENT_SERVER_MESH_USERNAME", DEFAULT_ROUTER_USER))
    args = parser.parse_args(argv)
    if args.command == "init-auth":
        path = init_router_auth(
            args.dir, password=os.environ.get("AGENT_SERVER_MESH_PASSWORD", "").strip(), username=args.username
        )
        print(f"wrote {path}")


if __name__ == "__main__":
    main()
