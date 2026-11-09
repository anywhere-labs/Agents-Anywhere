"""HTTP calls to Tokens Anywhere: OAuth endpoints, the account API and the
model gateway. Responses never reach clients as they are; the service picks
what to keep.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from agent_server.core.tokens_link import CLIENT_ID, MANAGED_KEY_APP

DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
# Refreshing rotates the token: keep the window where the outcome is unknown short.
REFRESH_TIMEOUT = httpx.Timeout(5.0, connect=3.0)


class TokensError(Exception):
    def __init__(self, code: str, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


class TokensInvalidGrantError(TokensError):
    """The code or refresh token is no longer valid: the link must be redone."""


class TokensUnauthorizedError(TokensError):
    """The access token or key was refused."""


class TokensUnavailableError(TokensError):
    """No answer, or an answer that says nothing about the request."""


@dataclass(frozen=True, slots=True)
class TokenPair:
    access_token: str
    refresh_token: str
    expires_in: int
    scope: str | None = None


@dataclass(slots=True)
class TokensClient:
    base_url: str
    transport: httpx.AsyncBaseTransport | None = field(default=None, repr=False)

    def _client(self, timeout: httpx.Timeout = DEFAULT_TIMEOUT) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            transport=self.transport,
            follow_redirects=False,
            headers={"Accept": "application/json"},
        )

    async def _send(
        self,
        method: str,
        path: str,
        *,
        timeout: httpx.Timeout = DEFAULT_TIMEOUT,
        **kwargs: Any,
    ) -> httpx.Response:
        try:
            async with self._client(timeout) as client:
                return await client.request(method, path, **kwargs)
        except httpx.HTTPError as exc:
            raise TokensUnavailableError("tokens_unavailable", "Tokens Anywhere did not answer") from exc

    async def _oauth(self, data: dict[str, str], *, timeout: httpx.Timeout) -> TokenPair:
        response = await self._send("POST", "/api/v1/oauth/token", data=data, timeout=timeout)
        body = _json(response)
        if response.status_code == 200 and body.get("access_token") and body.get("refresh_token"):
            return TokenPair(
                access_token=str(body["access_token"]),
                refresh_token=str(body["refresh_token"]),
                expires_in=int(body.get("expires_in") or 3600),
                scope=body.get("scope") or None,
            )
        error = str(body.get("error") or "")
        if error == "invalid_grant":
            raise TokensInvalidGrantError(error, "the authorization is no longer valid", status=response.status_code)
        if response.status_code >= 500 or not error:
            raise TokensUnavailableError("tokens_unavailable", "Tokens Anywhere could not issue a token")
        raise TokensError(error, str(body.get("error_description") or error), status=response.status_code)

    async def exchange_code(self, *, code: str, verifier: str, redirect_uri: str) -> TokenPair:
        return await self._oauth(
            {
                "grant_type": "authorization_code",
                "client_id": CLIENT_ID,
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": verifier,
            },
            timeout=DEFAULT_TIMEOUT,
        )

    async def refresh(self, refresh_token: str) -> TokenPair:
        return await self._oauth(
            {"grant_type": "refresh_token", "client_id": CLIENT_ID, "refresh_token": refresh_token},
            timeout=REFRESH_TIMEOUT,
        )

    async def revoke(self, token: str) -> None:
        response = await self._send("POST", "/api/v1/oauth/revoke", data={"token": token})
        if response.status_code != 200:
            raise TokensUnavailableError("tokens_unavailable", "Tokens Anywhere did not revoke the link")

    async def _api(self, method: str, path: str, access_token: str, **kwargs: Any) -> dict[str, Any]:
        response = await self._send(
            method, path, headers={"Authorization": f"Bearer {access_token}"}, **kwargs
        )
        return _checked(response)

    async def me(self, access_token: str) -> dict[str, Any]:
        return await self._api("GET", "/api/v1/me", access_token)

    async def managed_key(self, access_token: str) -> dict[str, Any]:
        """This link's key and its secret; the same key on every call."""
        body = await self._api("POST", "/api/v1/keys/managed", access_token, json={"app": MANAGED_KEY_APP})
        if not isinstance(body.get("key"), dict) or not body.get("secret"):
            raise TokensUnavailableError("tokens_unavailable", "Tokens Anywhere returned no key")
        return body

    async def rotate_key(self, access_token: str, key_id: str) -> dict[str, Any]:
        body = await self._api("POST", f"/api/v1/keys/{key_id}/rotate", access_token)
        if not body.get("secret"):
            raise TokensUnavailableError("tokens_unavailable", "Tokens Anywhere returned no key")
        return body

    async def models(self, api_key: str, *, anthropic: bool) -> list[dict[str, Any]]:
        headers = {"Authorization": f"Bearer {api_key}"}
        if anthropic:
            headers["anthropic-version"] = "2023-06-01"
        body = _checked(await self._send("GET", "/v1/models", headers=headers))
        data = body.get("data")
        return [item for item in data if isinstance(item, dict)] if isinstance(data, list) else []

    async def api_base_url(self) -> str | None:
        """Where the gateway serves ``/v1``; it may differ from the site's origin."""
        body = _checked(await self._send("GET", "/api/v1/status"))
        value = body.get("apiBaseUrl")
        return value if isinstance(value, str) and value else None

    async def pricing(self) -> dict[str, Any]:
        """The public price list: ``groups`` with each model's provider, and ``profiles``."""
        body = _checked(await self._send("GET", "/api/v1/pricing"))
        return {
            "groups": body.get("groups") if isinstance(body.get("groups"), list) else [],
            "profiles": body.get("profiles") if isinstance(body.get("profiles"), dict) else {},
        }

    async def embed_ticket(self, access_token: str, *, next_path: str) -> dict[str, Any]:
        """A one-minute, single-use address that opens the console in this instance's iframe."""
        body = await self._api("POST", "/api/v1/oauth/embed-tickets", access_token, json={"next": next_path})
        if not isinstance(body.get("url"), str) or not body["url"]:
            raise TokensUnavailableError("tokens_unavailable", "Tokens Anywhere returned no embed address")
        return body

    async def balance(self, access_token: str) -> dict[str, Any]:
        return await self._api("GET", "/api/v1/balance", access_token)

    async def usage_daily(self, access_token: str, *, start: str, end: str) -> list[dict[str, Any]]:
        """Settled usage per Beijing date and model, both ends included."""
        body = await self._api(
            "GET", "/api/v1/usage/daily", access_token, params={"from": start, "to": end, "groupBy": "model"}
        )
        items = body.get("items")
        return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def _json(response: httpx.Response) -> dict[str, Any]:
    try:
        body = response.json()
    except ValueError:
        return {}
    return body if isinstance(body, dict) else {}


def _checked(response: httpx.Response) -> dict[str, Any]:
    if response.status_code == 401:
        raise TokensUnauthorizedError("tokens_unauthorized", "Tokens Anywhere refused the credentials", status=401)
    if response.status_code >= 500:
        raise TokensUnavailableError("tokens_unavailable", "Tokens Anywhere is unavailable", status=response.status_code)
    if response.status_code >= 400:
        body = _json(response)
        # Problems arrive as {"error": {"code", "message"}}; older answers put the code at the top.
        error = body.get("error")
        code = error.get("code") if isinstance(error, dict) else (body.get("code") or error)
        raise TokensError(
            str(code or "tokens_request_failed"), "Tokens Anywhere refused the request", status=response.status_code
        )
    return _json(response)
