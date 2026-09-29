"""Tests for the OpenCode host-service peer: registry parsing, staleness rules,
envelope decoding, cursor pagination and SSE framing.

Every fixture is an `httpx.MockTransport` -- no socket, no real OpenCode. The
recorded shapes come from the live 2.0.18 service (see docs/opencode-server-surface.md):
lists are `{data, cursor}`, domain errors ride in **200** bodies as `_tag`, and an
unauthenticated call answers 200 with the Web UI's HTML.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from connector.runtimes.opencode.serve import (
    OpenCodeServerClient,
    OpenCodeService,
    OpenCodeServiceError,
    OpenCodeServiceUnavailable,
    read_service,
    service_file,
)

URL = "http://127.0.0.1:49374"


def write_service(state_home: Path, payload: dict[str, Any]) -> Path:
    target = service_file(state_home)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload), encoding="utf-8")
    return target


def service(pid: int = 18772, version: str = "2.0.18") -> OpenCodeService:
    return OpenCodeService(url=URL, pid=pid, version=version, password="sekret", path=Path("service.json"))


def client_for(handler: Any, **kwargs: Any) -> OpenCodeServerClient:
    return OpenCodeServerClient(service(**kwargs), transport=httpx.MockTransport(handler))


class TestReadService:
    def test_reads_a_valid_registration(self, tmp_path: Path) -> None:
        write_service(
            tmp_path,
            {"id": "x", "version": "2.0.18", "url": URL, "pid": 18772, "password": "sekret"},
        )
        found = read_service(tmp_path)
        assert found is not None
        assert (found.url, found.pid, found.version, found.password) == (URL, 18772, "2.0.18", "sekret")
        assert found.origin == URL

    def test_missing_file_is_absent_not_error(self, tmp_path: Path) -> None:
        assert read_service(tmp_path) is None

    @pytest.mark.parametrize(
        "payload",
        [
            {"pid": 1, "version": "2.0.18", "password": "p"},  # no url
            {"url": "ftp://x", "pid": 1, "version": "2.0.18", "password": "p"},  # not http
            {"url": URL, "pid": 0, "version": "2.0.18", "password": "p"},  # bad pid
            {"url": URL, "pid": 1, "version": "", "password": "p"},  # no version
            {"url": URL, "pid": 1, "version": "2.0.18", "password": ""},  # no password
            {"url": URL, "pid": True, "version": "2.0.18", "password": "p"},  # bool is not a pid
            ["not", "an", "object"],  # wrong top-level shape
        ],
    )
    def test_unusable_records_are_ignored(self, tmp_path: Path, payload: dict[str, Any] | list[str]) -> None:
        write_service(tmp_path, payload)
        assert read_service(tmp_path) is None

    def test_corrupt_json_is_ignored(self, tmp_path: Path) -> None:
        target = service_file(tmp_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("{not json", encoding="utf-8")
        assert read_service(tmp_path) is None


class TestVerify:
    def test_accepts_a_matching_live_service(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/api/info"
            assert request.headers["authorization"] == "Basic " + _b64("opencode:sekret")
            return httpx.Response(200, json={"version": "2.0.18", "pid": 18772, "urls": [URL], "paths": {"tmp": "T"}})

        async def run() -> None:
            client = client_for(handler)
            try:
                info = await client.verify(expected_version="2.0.18")
                assert info["pid"] == 18772
            finally:
                await client.aclose()

        asyncio.run(run())

    def test_stale_pid_is_unavailable(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"version": "2.0.18", "pid": 999})

        async def run() -> None:
            client = client_for(handler)
            try:
                with pytest.raises(OpenCodeServiceUnavailable, match="pid changed"):
                    await client.verify()
            finally:
                await client.aclose()

        asyncio.run(run())

    def test_version_drift_is_unavailable(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"version": "2.0.16", "pid": 18772})

        async def run() -> None:
            client = client_for(handler)
            try:
                with pytest.raises(OpenCodeServiceUnavailable, match="not the validated"):
                    await client.verify(expected_version="2.0.18")
            finally:
                await client.aclose()

        asyncio.run(run())


class TestDecoding:
    def test_unwraps_the_data_envelope(self) -> None:
        client = client_for(lambda request: httpx.Response(200, json={"data": [{"id": "ses_1"}]}))

        async def run() -> None:
            try:
                assert await client.get("/api/skill") == [{"id": "ses_1"}]
            finally:
                await client.aclose()

        asyncio.run(run())

    def test_domain_error_in_a_200_body_raises(self) -> None:
        client = client_for(
            lambda request: httpx.Response(200, json={"_tag": "SessionNotFoundError", "sessionID": "ses_x"})
        )

        async def run() -> None:
            try:
                with pytest.raises(OpenCodeServiceError) as caught:
                    await client.get("/api/session/ses_x")
                assert caught.value.tag == "SessionNotFoundError"
                assert caught.value.status == 200
            finally:
                await client.aclose()

        asyncio.run(run())

    def test_html_answer_is_treated_as_unreachable_not_as_success(self) -> None:
        # What an unauthenticated call really returns: 200 + the Web UI shell.
        client = client_for(lambda request: httpx.Response(200, text="<!doctype html><html><body>x</body></html>"))

        async def run() -> None:
            try:
                with pytest.raises(OpenCodeServiceUnavailable, match="non-JSON"):
                    await client.get("/api/session")
            finally:
                await client.aclose()

        asyncio.run(run())

    def test_http_status_failure_keeps_the_status(self) -> None:
        client = client_for(lambda request: httpx.Response(404, json={"_tag": "NotFound"}))

        async def run() -> None:
            try:
                with pytest.raises(OpenCodeServiceError) as caught:
                    await client.get("/api/nope")
                assert caught.value.status == 404
            finally:
                await client.aclose()

        asyncio.run(run())

    def test_an_empty_success_body_is_none_not_an_outage(self) -> None:
        # Measured: `DELETE /api/session/{id}` (and `/model`, `/agent`,
        # `/command`) answer with no body at all. The old code ran `.json()` on
        # it and reported the service as unreachable.
        client = client_for(lambda request: httpx.Response(204))

        async def run() -> None:
            try:
                assert await client.post("/api/session/ses_1") is None
                assert await client.get("/api/session/ses_1/permission") is None
            finally:
                await client.aclose()

        asyncio.run(run())

    def test_post_sends_a_json_body(self) -> None:
        seen: dict[str, Any] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            seen["path"] = request.url.path
            seen["body"] = json.loads(request.content.decode())
            return httpx.Response(200, json={})

        client = client_for(handler)

        async def run() -> None:
            try:
                await client.post("/api/session/ses_1/permission/per_1/reply", {"decision": "once"})
                assert seen["path"] == "/api/session/ses_1/permission/per_1/reply"
                assert seen["body"] == {"decision": "once"}
            finally:
                await client.aclose()

        asyncio.run(run())


class TestListSessions:
    def test_passes_scoping_params_and_follows_the_cursor(self) -> None:
        calls: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            params = dict(request.url.params)
            calls.append(params)
            if "cursor" not in params:
                return httpx.Response(
                    200,
                    json={"data": [{"id": "ses_1"}, {"id": "ses_2"}], "cursor": {"previous": None, "next": "c2"}},
                )
            return httpx.Response(
                200, json={"data": [{"id": "ses_3", "parentID": "ses_1"}], "cursor": {"previous": "c2", "next": None}}
            )

        client = client_for(handler)

        async def run() -> None:
            try:
                rows = await client.list_sessions(directory="/work/repo", parent_id="null", limit=50)
                assert [r["id"] for r in rows] == ["ses_1", "ses_2", "ses_3"]
                assert calls[0]["directory"] == "/work/repo"
                assert calls[0]["parentID"] == "null"
                assert calls[0]["limit"] == "50"
                assert "parentID" not in calls[1] or calls[1]["parentID"] == "null"
                assert calls[1]["cursor"] == "c2"
            finally:
                await client.aclose()

        asyncio.run(run())

    def test_omits_unset_filters(self) -> None:
        captured: dict[str, str] = {}

        def handler(request: httpx.Request) -> httpx.Response:
            captured.update(dict(request.url.params))
            return httpx.Response(200, json={"data": [], "cursor": {"next": None}})

        client = client_for(handler)

        async def run() -> None:
            try:
                await client.list_sessions()
            finally:
                await client.aclose()

        asyncio.run(run())
        assert "directory" not in captured
        assert "parentID" not in captured


class TestListMessages:
    """Guards the three measured quirks of `/api/session/{id}/message`.

    Real 2.0.18 behaviour: rows are newest-first unless `order=asc` is asked for,
    a `cursor` sent together with `order` is rejected with `InvalidCursorError`,
    `limit` above 200 is an HTTP 400, and a page can offer a `next` cursor that
    then returns nothing.
    """

    def test_asks_for_oldest_first_and_never_repeats_order_with_a_cursor(self) -> None:
        calls: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            params = dict(request.url.params)
            calls.append(params)
            if "cursor" not in params:
                return httpx.Response(
                    200, json={"data": [{"id": "m1"}, {"id": "m2"}], "cursor": {"previous": None, "next": "c2"}}
                )
            return httpx.Response(
                200, json={"data": [{"id": "m3"}], "cursor": {"previous": "c2", "next": None}}
            )

        client = client_for(handler)

        async def run() -> None:
            try:
                rows = await client.list_messages("ses_1")
                assert [row["id"] for row in rows] == ["m1", "m2", "m3"]
                assert calls[0]["order"] == "asc"
                assert "cursor" not in calls[0]
                assert calls[1]["cursor"] == "c2"
                assert "order" not in calls[1], "the host rejects cursor+order with InvalidCursorError"
            finally:
                await client.aclose()

        asyncio.run(run())

    def test_page_size_stays_inside_what_the_service_accepts(self) -> None:
        calls: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(dict(request.url.params))
            return httpx.Response(200, json={"data": [], "cursor": {"next": None}})

        client = client_for(handler)

        async def run() -> None:
            try:
                await client.list_messages("ses_1")
                await client.list_messages("ses_1", limit=5000)
            finally:
                await client.aclose()

        asyncio.run(run())
        assert [call["limit"] for call in calls] == ["200", "200"]

    def test_a_limit_reads_from_the_newest_end_and_returns_time_ascending(self) -> None:
        calls: list[dict[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(dict(request.url.params))
            # The host's newest-first answer, as stored.
            return httpx.Response(200, json={"data": [{"id": "m3"}, {"id": "m2"}, {"id": "m1"}], "cursor": {"next": None}})

        client = client_for(handler)

        async def run() -> None:
            try:
                rows = await client.list_messages("ses_1", limit=3)
                assert [row["id"] for row in rows] == ["m1", "m2", "m3"]
            finally:
                await client.aclose()

        asyncio.run(run())
        assert calls[0]["order"] == "desc"

    def test_a_limit_shorter_than_the_window_keeps_the_newest_rows(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                200, json={"data": [{"id": f"m{i}"} for i in range(5, 0, -1)], "cursor": {"next": None}}
            )

        client = client_for(handler)

        async def run() -> None:
            try:
                rows = await client.list_messages("ses_1", limit=2)
                assert [row["id"] for row in rows] == ["m4", "m5"]
            finally:
                await client.aclose()

        asyncio.run(run())

    def test_stops_on_an_empty_page_even_when_a_cursor_is_offered(self) -> None:
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            params = dict(request.url.params)
            calls.append(params.get("cursor", "first"))
            if len(calls) == 1:
                return httpx.Response(200, json={"data": [{"id": "m1"}], "cursor": {"next": "c2"}})
            return httpx.Response(200, json={"data": [], "cursor": {"next": "c3"}})

        client = client_for(handler)

        async def run() -> None:
            try:
                assert [row["id"] for row in await client.list_messages("ses_1")] == ["m1"]
            finally:
                await client.aclose()

        asyncio.run(run())
        assert calls == ["first", "c2"]


class TestStreamEvents:
    def test_yields_frames_and_skips_heartbeats(self) -> None:
        body = (
            'data: {"id":"evt_1","event":"server.connected","data":{}}\n\n'
            ": heartbeat\n\n"
            'data: {"id":"evt_2","event":"session.execution.succeeded","data":{"sessionID":"ses_1"}}\n\n'
        )
        client = client_for(
            lambda request: httpx.Response(
                200, headers={"content-type": "text/event-stream"}, text=body
            )
        )

        async def run() -> None:
            try:
                frames = [frame async for frame in client.stream_events()]
                assert [f["event"] for f in frames] == ["server.connected", "session.execution.succeeded"]
                assert frames[1]["data"] == {"sessionID": "ses_1"}
            finally:
                await client.aclose()

        asyncio.run(run())

    def test_refused_stream_raises(self) -> None:
        client = client_for(lambda request: httpx.Response(401, text="nope"))

        async def run() -> None:
            try:
                with pytest.raises(OpenCodeServiceError):
                    [frame async for frame in client.stream_events()]
            finally:
                await client.aclose()

        asyncio.run(run())


def _b64(text: str) -> str:
    import base64

    return base64.b64encode(text.encode()).decode()
