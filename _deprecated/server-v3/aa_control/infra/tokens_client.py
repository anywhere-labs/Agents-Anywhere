from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol

import httpx

from aa_control.core.config import TokensAnywhereConfig


@dataclass(frozen=True)
class TokensRefreshResult:
    status: Literal["refreshed", "invalid_grant", "transient_error"]
    refresh_token: str | None = None
    access_token: str | None = None


class TokensAnywhereClientPort(Protocol):
    async def refresh_token(self, *, refresh_token: str) -> TokensRefreshResult: ...

    async def revoke_token(self, *, token: str) -> bool: ...

    async def close(self) -> None: ...


class HttpTokensAnywhereClient:
    """Async HTTP client for Tokens Anywhere OAuth refresh & revocation (RFC 7009)."""

    def __init__(
        self,
        config: TokensAnywhereConfig,
        *,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._cfg = config
        self._own_client = http_client is None
        self._http = http_client or httpx.AsyncClient(timeout=config.request_timeout_seconds)

    async def close(self) -> None:
        if self._own_client:
            await self._http.aclose()

    def _base_form(self) -> dict[str, str]:
        form: dict[str, str] = {"client_id": self._cfg.client_id}
        if self._cfg.client_secret:
            form["client_secret"] = self._cfg.client_secret
        return form

    async def refresh_token(self, *, refresh_token: str) -> TokensRefreshResult:
        form = {
            **self._base_form(),
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }
        try:
            resp = await self._http.post(
                f"{self._cfg.base_url}/api/v1/oauth/token",
                data=form,
                headers={"Accept": "application/json"},
            )
        except httpx.HTTPError:
            return TokensRefreshResult(status="transient_error")

        if resp.status_code == 200:
            try:
                data = resp.json()
            except ValueError:
                return TokensRefreshResult(status="transient_error")
            new_refresh = data.get("refresh_token") if isinstance(data, dict) else None
            new_access = data.get("access_token") if isinstance(data, dict) else None
            if isinstance(new_refresh, str) and new_refresh.strip():
                return TokensRefreshResult(
                    status="refreshed",
                    refresh_token=new_refresh.strip(),
                    access_token=new_access.strip() if isinstance(new_access, str) and new_access.strip() else None,
                )
            return TokensRefreshResult(status="transient_error")

        if resp.status_code == 400:
            # invalid_grant: the authorization grant is gone or expired.
            return TokensRefreshResult(status="invalid_grant")

        return TokensRefreshResult(status="transient_error")

    async def revoke_token(self, *, token: str) -> bool:
        """Best-effort RFC 7009 revocation; withdrawing the grant deletes its managed Key on Tokens."""
        form = {
            **self._base_form(),
            "token": token,
        }
        try:
            resp = await self._http.post(
                f"{self._cfg.base_url}/api/v1/oauth/revoke",
                data=form,
                headers={"Accept": "application/json"},
            )
            return 200 <= resp.status_code < 300
        except httpx.HTTPError:
            return False
