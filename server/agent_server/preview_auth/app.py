"""preview-auth: checks every request to a port preview, without calling the Server.

Runs as its own process next to the gateway (``uvicorn agent_server.preview_auth.app:app``);
the main Server never sees preview traffic. Two routes:

- ``GET /verify``: the gateway's ``forward_auth``. Reads the preview host and the
  ``__Host-aa_preview`` cookie, checks the cookie's signature and expiry, and checks in
  Redis that the slug is still open (cached for a few seconds). 2xx lets the request
  through, with ``X-Aa-Cookie`` holding the browser's cookies minus the preview cookie
  (the gateway forwards that instead, so the previewed page never sees it); otherwise a
  page navigation is sent to the AA sign-in page and anything else gets 401.
- ``GET /__aa/ticket?t=...``: routed here on every preview host. Redeems the one-time
  ticket through the Server and sets the cookie, then redirects to ``/``.

Configuration: ``AGENT_SERVER_PREVIEW_DOMAIN``, ``AGENT_SERVER_PREVIEW_INTERNAL_TOKEN``,
``AGENT_SERVER_REDIS_URL`` (required), ``AGENT_SERVER_REDIS_PREFIX``,
``AGENT_SERVER_PREVIEW_SERVER_URL`` (the Server on the internal network) and
``AGENT_SERVER_PUBLIC_ORIGIN`` (where sign-in redirects go).
"""

from __future__ import annotations

import json
import os
import time
from http.cookies import CookieError, SimpleCookie
from typing import Any

import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import (
    HTMLResponse,
    PlainTextResponse,
    RedirectResponse,
    Response,
)
from starlette.routing import Route

from agent_server.core.preview_access import (
    COOKIE,
    COOKIE_NAME,
    TICKET_PATH,
    internal_token,
    preview_domain,
    slug_from_host,
    state_key,
    verify,
)

STATE_CACHE_SECONDS = 3.0
_PAGE = (
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
    "<title>Agents Anywhere</title><body style='font-family:system-ui;padding:2rem'><p>{zh}</p><p>{en}</p>"
)
_CLOSED = _PAGE.format(zh="这个预览已经关闭或过期。", en="This preview was closed or has expired.")
_BAD_TICKET = _PAGE.format(
    zh="这个预览链接已失效，请在 Agents Anywhere 里重新打开预览。",
    en="This preview link is no longer valid. Open the preview again from Agents Anywhere.",
)


class PreviewAuth:
    def __init__(
        self,
        *,
        redis: Any,
        server: httpx.AsyncClient,
        prefix: str,
        login_url: str,
        clock=time.time,
    ) -> None:
        self._redis = redis
        self._server = server
        self._prefix = prefix
        self._login_url = login_url
        self._clock = clock
        self._cache: dict[str, tuple[float, dict[str, Any] | None]] = {}

    async def _state(self, slug: str) -> dict[str, Any] | None:
        now = self._clock()
        cached = self._cache.get(slug)
        if cached is not None and cached[0] > now:
            return cached[1]
        raw = await self._redis.get(state_key(self._prefix, slug))
        state = json.loads(raw.decode() if isinstance(raw, bytes) else raw) if raw else None
        if len(self._cache) > 10_000:
            self._cache.clear()
        self._cache[slug] = (now + STATE_CACHE_SECONDS, state)
        return state

    @staticmethod
    def _host(request: Request) -> str | None:
        return request.headers.get("x-forwarded-host") or request.headers.get("host")

    @staticmethod
    def _cookies(request: Request) -> tuple[str | None, str]:
        """The preview cookie and the rest of the Cookie header."""

        ours: str | None = None
        others: list[str] = []
        for part in (request.headers.get("cookie") or "").split(";"):
            name, _, value = part.strip().partition("=")
            if not name:
                continue
            if name == COOKIE_NAME:
                ours = value
            else:
                others.append(f"{name}={value}")
        return ours, "; ".join(others)

    def _denied(self, request: Request, status: int) -> Response:
        navigation = request.headers.get("sec-fetch-mode") == "navigate" or (
            request.headers.get("x-forwarded-method", "GET") == "GET"
            and "text/html" in (request.headers.get("accept") or "")
        )
        if status == 401 and navigation:
            return RedirectResponse(self._login_url, status_code=302)
        if status == 404 and navigation:
            return HTMLResponse(_CLOSED, status_code=404)
        return PlainTextResponse("preview access denied", status_code=status)

    async def verify(self, request: Request) -> Response:
        domain, token = preview_domain(), internal_token()
        slug = slug_from_host(self._host(request), domain) if domain else None
        if slug is None or token is None:
            return PlainTextResponse("not a preview host", status_code=404)
        state = await self._state(slug)
        if state is None or float(state.get("exp") or 0) <= self._clock():
            return self._denied(request, 404)
        cookie, others = self._cookies(request)
        if state.get("visibility") != "link":
            claims = verify(token, COOKIE, cookie, now=self._clock())
            if (
                claims is None
                or claims.get("s") != slug
                or claims.get("u") != state.get("userId")
                or claims.get("p") != state.get("previewId")
            ):
                return self._denied(request, 401)
        response = Response(status_code=204)
        if others:
            response.headers["X-Aa-Cookie"] = others
        return response

    async def ticket(self, request: Request) -> Response:
        domain, token = preview_domain(), internal_token()
        slug = slug_from_host(self._host(request), domain) if domain else None
        ticket = request.query_params.get("t")
        if slug is None or token is None or not ticket:
            return HTMLResponse(_BAD_TICKET, status_code=400)
        try:
            answer = await self._server.post(
                "/api/v3/internal/preview/redeem",
                json={"ticket": ticket, "slug": slug},
                headers={"Authorization": f"Bearer {token}"},
            )
        except httpx.HTTPError:
            return HTMLResponse(_BAD_TICKET, status_code=502)
        if answer.status_code != 200:
            return HTMLResponse(_BAD_TICKET, status_code=403)
        body = answer.json()
        jar: SimpleCookie = SimpleCookie()
        try:
            jar[COOKIE_NAME] = body["cookie"]
        except (CookieError, KeyError):
            return HTMLResponse(_BAD_TICKET, status_code=502)
        morsel = jar[COOKIE_NAME]
        morsel["path"] = "/"
        morsel["max-age"] = str(int(body.get("maxAge") or 0))
        morsel["secure"] = True
        morsel["httponly"] = True
        morsel["samesite"] = "Lax"
        response = RedirectResponse("/", status_code=302)
        response.headers["Set-Cookie"] = morsel.OutputString()
        response.headers["Cache-Control"] = "no-store"
        response.headers["Referrer-Policy"] = "no-referrer"
        self._cache.pop(slug, None)
        return response


def create_app(
    *,
    redis: Any | None = None,
    server: httpx.AsyncClient | None = None,
    clock=time.time,
) -> Starlette:
    if redis is None:
        from redis.asyncio import Redis

        url = os.environ.get("AGENT_SERVER_REDIS_URL")
        if not url:
            raise RuntimeError("preview-auth needs AGENT_SERVER_REDIS_URL")
        redis = Redis.from_url(url)
    if server is None:
        server = httpx.AsyncClient(
            base_url=os.environ.get("AGENT_SERVER_PREVIEW_SERVER_URL", "http://agent-server-next:8000"),
            timeout=10.0,
        )
    auth = PreviewAuth(
        redis=redis,
        server=server,
        prefix=os.environ.get("AGENT_SERVER_REDIS_PREFIX", "agents-anywhere").strip(":") or "agents-anywhere",
        login_url=(os.environ.get("AGENT_SERVER_PUBLIC_ORIGIN") or "/").rstrip("/") + "/",
        clock=clock,
    )

    async def healthz(_request: Request) -> Response:
        return PlainTextResponse("ok")

    app = Starlette(
        routes=[
            Route("/verify", auth.verify, methods=["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
            Route(TICKET_PATH, auth.ticket, methods=["GET"]),
            Route("/healthz", healthz, methods=["GET"]),
        ]
    )
    app.state.auth = auth
    return app


def __getattr__(name: str) -> Any:
    # ``uvicorn agent_server.preview_auth.app:app`` builds the app from the environment on first use.
    if name == "app":
        built = create_app()
        globals()["app"] = built
        return built
    raise AttributeError(name)
