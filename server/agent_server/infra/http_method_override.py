"""POST + ``X-HTTP-Method-Override`` support for restricted HTTP clients."""

from __future__ import annotations

from starlette.types import ASGIApp, Receive, Scope, Send

_OVERRIDE_HEADER = b"x-http-method-override"
_ALLOWED_METHODS = frozenset({"PATCH", "PUT", "DELETE"})


class HttpMethodOverrideMiddleware:
    """Rewrite POST requests carrying ``X-HTTP-Method-Override``.

    The HarmonyOS ``@ohos.net.http`` stack only exposes ``RequestMethod.PATCH``
    from API 26, so HarmonyOS clients on API 12 send PATCH as POST with the
    override header (the convention used by Google Cloud / Heroku). Only POST
    may be overridden, and only to PATCH/PUT/DELETE.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope.get("method") == "POST":
            for name, value in scope.get("headers") or ():
                if name.lower() == _OVERRIDE_HEADER:
                    override = value.decode("latin-1").strip().upper()
                    if override in _ALLOWED_METHODS:
                        scope = dict(scope)
                        scope["method"] = override
                    break
        await self.app(scope, receive, send)
