"""HTTP/SSE client for the OpenCode host service (2.0.18 measured).

Three behaviours of this API are surprising and are handled here once, so no
caller has to rediscover them:

* Unauthenticated requests answer **200 with the Web UI's HTML** for every path,
  so a status code alone can never prove a route exists.
* Domain errors travel inside **200 bodies** as `{"_tag": "...Error", ...}`
  (e.g. `SessionNotFoundError`), so every response is unwrapped through
  :meth:`OpenCodeServerClient._decode`.
* Location scoping is a **query parameter** (`?directory=`); the
  `x-opencode-directory` header does not filter list results.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Mapping
from typing import Any

import httpx

from connector.runtimes.opencode.serve.service import OpenCodeService

AUTH_USERNAME = "opencode"
DEFAULT_TIMEOUT_SECONDS = 30.0
DEFAULT_PAGE_LIMIT = 200
#: Highest `limit` the message endpoint accepts; above it the service answers
#: HTTP 400 `InvalidRequestError … less than or equal to 200`.
MESSAGE_PAGE = 200
MAX_PAGES = 200


class OpenCodeServiceError(RuntimeError):
    """A domain error the service reported (in-body `_tag` envelope or HTTP 4xx/5xx)."""

    def __init__(self, tag: str, message: str, *, status: int | None = None) -> None:
        super().__init__(f"{tag}: {message}")
        self.tag = tag
        self.status = status


class OpenCodeServiceUnavailable(RuntimeError):
    """The service cannot be reached or is not the version we registered."""


def _is_error_envelope(payload: Mapping[str, Any]) -> bool:
    tag = payload.get("_tag")
    return isinstance(tag, str) and tag.endswith("Error")


class OpenCodeServerClient:
    """Thin, unopinionated accessor for the host's own `/api` surface."""

    def __init__(
        self,
        service: OpenCodeService,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._service = service
        self._http = httpx.AsyncClient(
            base_url=service.origin,
            auth=(AUTH_USERNAME, service.password),
            timeout=timeout,
            transport=transport,
            headers={"accept": "application/json"},
        )

    @property
    def service(self) -> OpenCodeService:
        return self._service

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(self, method: str, path: str, *, params: Mapping[str, Any] | None = None,
                       json_body: Any = None) -> Any:
        try:
            response = await self._http.request(method, path, params=dict(params or {}), json=json_body)
        except httpx.HTTPError as error:  # network-level failure is never a domain answer
            raise OpenCodeServiceUnavailable(f"cannot reach {self._service.origin}: {error}") from error
        if response.status_code >= 400:
            raise OpenCodeServiceError(
                f"HTTP_{response.status_code}",
                response.text[:200],
                status=response.status_code,
            )
        if not response.content:
            # Several write endpoints (`/model`, `/agent`, `/command`,
            # `DELETE /api/session/{id}`) answer 200 with an empty body. Parsing
            # that as JSON failed and the call was reported as "service
            # unreachable" -- so every selection change looked like an outage.
            return None
        try:
            payload = response.json()
        except (json.JSONDecodeError, ValueError) as error:
            # HTML on a JSON call means the credentials did not take effect.
            raise OpenCodeServiceUnavailable(
                f"{path} answered non-JSON; the service may be unreachable or unauthenticated"
            ) from error
        if isinstance(payload, dict) and _is_error_envelope(payload):
            raise OpenCodeServiceError(
                str(payload["_tag"]),
                str(payload.get("message") or path),
                status=response.status_code,
            )
        return payload

    @staticmethod
    def _unwrap(payload: Any) -> Any:
        if isinstance(payload, dict) and "data" in payload and len(payload) <= 2:
            return payload["data"]
        return payload

    async def get(self, path: str, params: Mapping[str, Any] | None = None) -> Any:
        return self._unwrap(await self._request("GET", path, params=params))

    async def post(self, path: str, body: Any = None, params: Mapping[str, Any] | None = None) -> Any:
        return self._unwrap(await self._request("POST", path, params=params, json_body=body))

    async def info(self) -> dict[str, Any]:
        """`GET /api/info` -- identity, live pid, advertised URLs."""
        payload = await self._request("GET", "/api/info")
        return payload if isinstance(payload, dict) else {}

    async def verify(self, expected_version: str | None = None) -> dict[str, Any]:
        """Confirm the registry file still describes the live process.

        Mirrors the host's own client: a pid mismatch means the file is stale, and
        a version mismatch means we are talking to something we have not validated.
        """
        info = await self.info()
        if info.get("pid") != self._service.pid:
            raise OpenCodeServiceUnavailable(
                f"service pid changed: registered {self._service.pid}, live {info.get('pid')}"
            )
        version = str(info.get("version") or "")
        if expected_version is not None and version != expected_version:
            raise OpenCodeServiceUnavailable(
                f"service version {version!r} is not the validated {expected_version!r}"
            )
        return info

    async def list_sessions(
        self,
        *,
        directory: str | None = None,
        project: str | None = None,
        parent_id: str | None = None,
        limit: int = DEFAULT_PAGE_LIMIT,
    ) -> list[dict[str, Any]]:
        """Follow `cursor.next` until the list is exhausted.

        `parent_id` is passed through verbatim, so the literal string ``"null"``
        asks the service for top-level sessions only; leaving it out means "do not
        filter by parent".
        """
        params: dict[str, Any] = {"limit": str(limit)}
        if directory is not None:
            params["directory"] = directory
        if project is not None:
            params["project"] = project
        if parent_id is not None:
            params["parentID"] = parent_id
        sessions: list[dict[str, Any]] = []
        cursor: str | None = None
        for _ in range(MAX_PAGES):
            page = await self._request("GET", "/api/session", params={**params, **({"cursor": cursor} if cursor else {})})
            rows = page.get("data") if isinstance(page, dict) else page
            if isinstance(rows, list):
                sessions.extend(row for row in rows if isinstance(row, dict))
            cursor = ((page.get("cursor") or {}) if isinstance(page, dict) else {}).get("next")
            if not cursor:
                return sessions
        return sessions

    async def list_messages(
        self,
        session_id: str,
        *,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        """Collect a session's stored messages **in chronological order**.

        Three measured facts shape this call (`docs/opencode-server-surface.md`):
        the endpoint answers newest-first unless `order=asc` is asked for, its
        default page is 50 and `limit` above 200 is a 400, and a cursor carries
        its own order so `cursor` + `order` together is rejected outright. So the
        first page names the order and every later page names only the cursor;
        with `limit` the walk starts at the newest end and the slice is reversed
        back into time order.
        """
        descending = limit is not None
        want = limit if descending else MESSAGE_PAGE
        order = "desc" if descending else "asc"
        page_size = str(max(1, min(int(want), MESSAGE_PAGE)))
        messages: list[dict[str, Any]] = []
        cursor: str | None = None
        for _ in range(MAX_PAGES):
            params: dict[str, Any] = {"limit": page_size}
            if cursor is None:
                params["order"] = order
            else:
                params["cursor"] = cursor
            page = await self._request("GET", f"/api/session/{session_id}/message", params=params)
            rows = page.get("data") if isinstance(page, dict) else None
            rows = [row for row in (rows or []) if isinstance(row, dict)]
            if not rows:
                break
            messages.extend(rows)
            if descending and limit is not None and len(messages) >= limit:
                break
            cursor = ((page.get("cursor") or {}) if isinstance(page, dict) else {}).get("next")
            if not cursor:
                break
        if descending:
            messages.reverse()
            if limit is not None:
                messages = messages[-limit:]
        return messages

    async def stream_events(self) -> AsyncIterator[dict[str, Any]]:
        """Yield decoded `data:` frames from `GET /api/event` (SSE).

        A frame is `{id, type, data}` plus optional `created`, `location`
        (`{"directory": …}`) and `durable` (`{aggregateID, seq, version}`) -- the
        discriminator is `type`, not `event`. The endpoint takes no parameters and
        ignores `Last-Event-ID` (measured on a reconnect), so a dropped
        connection cannot resume: callers must re-read the list endpoints, which
        is what the runtime's durable-sequence tracking is for.
        """
        async with self._http.stream("GET", "/api/event", headers={"accept": "text/event-stream"}) as response:
            if response.status_code >= 400:
                raise OpenCodeServiceError(f"HTTP_{response.status_code}", "event stream refused", status=response.status_code)
            data_lines: list[str] = []
            async for line in response.aiter_lines():
                if line.startswith(":"):
                    continue
                if line == "":
                    frame = "\n".join(data_lines)
                    data_lines.clear()
                    if frame:
                        try:
                            parsed = json.loads(frame)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(parsed, dict):
                            yield parsed
                    continue
                if line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())
