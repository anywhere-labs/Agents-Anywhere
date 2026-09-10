from __future__ import annotations

import asyncio
import time
from collections.abc import Callable

import httpx

from connector.core.config import ConnectorConfig
from connector.server.errors import ConnectorNetworkError
from connector.server.urls import api_v2_url

ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 60.0


class ConnectorAuthenticationError(RuntimeError):
    """Connector credentials are invalid or revoked; do not retry."""


HttpClientGetter = Callable[[], httpx.AsyncClient | None]
HttpClientFactory = Callable[[httpx.Timeout | float], httpx.AsyncClient]


class ConnectorAuthenticator:
    def __init__(
        self,
        config: ConnectorConfig,
        http_client_getter: HttpClientGetter,
        http_client_factory: HttpClientFactory,
    ) -> None:
        self._config = config
        self._http_client_getter = http_client_getter
        self._http_client_factory = http_client_factory
        self._access_token: str | None = None
        self._access_token_expires_at: float = 0
        self._auth_lock = asyncio.Lock()

    async def authenticate(self) -> str:
        client = self._http_client_getter()
        # authenticate() may run before the shared client exists. Fall back to
        # a one-shot client in that case.
        owned = client is None
        if client is None:
            client = self._http_client_factory(30)
        try:
            try:
                response = await client.post(
                    api_v2_url(self._config.server_url, "/connector/auth"),
                    headers={
                        "Authorization": f"Connector {self._config.connector_id}:{self._config.connector_token}",
                    },
                )
            except httpx.RequestError as exc:
                raise ConnectorNetworkError(
                    f"backend authentication request failed: {exc}"
                ) from exc
            if response.status_code == 401:
                raise ConnectorAuthenticationError("invalid connector credential")
            response.raise_for_status()
            body = response.json()
            access_token = body["accessToken"]
            if not isinstance(access_token, str):
                raise RuntimeError("backend returned invalid connector accessToken")
            expires_in = body.get("expiresIn")
            if not isinstance(expires_in, int | float):
                raise RuntimeError("backend returned invalid connector expiresIn")
            self._access_token = access_token
            self._access_token_expires_at = time.monotonic() + float(expires_in)
            return access_token
        finally:
            if owned:
                await client.aclose()

    async def ensure_access_token(self, force: bool = False) -> str:
        async with self._auth_lock:
            if (
                not force
                and self._access_token
                and time.monotonic()
                < self._access_token_expires_at - ACCESS_TOKEN_REFRESH_SKEW_SECONDS
            ):
                return self._access_token
            return await self.authenticate()
