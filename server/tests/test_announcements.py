from __future__ import annotations

import asyncio
from datetime import datetime

import pytest
from agent_server.core.announcement import AnnouncementUpdate
from agent_server.services.announcements import (
    AnnouncementService,
    next_publication_time,
)
from test_backend_mvp import auth_headers, make_client


def test_public_announcement_is_available_before_login_and_hides_drafts(tmp_path):
    client = make_client(tmp_path)
    response = client.get("/api/v2/announcement")
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert response.json() == {"announcement": None}
    admin = auth_headers(client)
    draft = client.put(
        "/admin/announcement",
        headers=admin,
        json={"enabled": False, "markdown": "private draft"},
    )
    assert draft.status_code == 200
    assert draft.json()["publishedAt"] is None
    assert client.get("/api/v2/announcement").json() == {"announcement": None}
    assert (
        client.get("/admin/announcement", headers=admin).json()["markdown"]
        == "private draft"
    )


def test_only_admin_can_read_or_change_announcement_settings(tmp_path):
    client = make_client(tmp_path)
    admin = auth_headers(client)
    member = auth_headers(client, user_id="member")
    for headers in ({}, member):
        assert client.get("/admin/announcement", headers=headers).status_code in {
            401,
            403,
        }
        assert client.put(
            "/admin/announcement",
            headers=headers,
            json={"enabled": True, "markdown": "forbidden"},
        ).status_code in {401, 403}
    assert client.get("/admin/announcement", headers=admin).json()["enabled"] is False


def test_publication_changes_only_when_published_content_changes_or_is_reenabled(
    tmp_path,
):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    def save(enabled, markdown):
        response = client.put(
            "/admin/announcement",
            headers=headers,
            json={"enabled": enabled, "markdown": markdown},
        )
        assert response.status_code == 200, response.text
        return response.json()

    first = save(True, "## Hello\n\n**World**")
    assert client.get("/api/v2/announcement").json()["announcement"] == {
        "markdown": first["markdown"],
        "publishedAt": first["publishedAt"],
    }
    assert save(True, first["markdown"])["publishedAt"] == first["publishedAt"]
    changed = save(True, "new publication")
    assert datetime.fromisoformat(changed["publishedAt"]) > datetime.fromisoformat(
        first["publishedAt"]
    )
    assert save(False, changed["markdown"])["publishedAt"] == changed["publishedAt"]
    assert client.get("/api/v2/announcement").json() == {"announcement": None}
    assert save(False, "edited draft")["publishedAt"] == changed["publishedAt"]
    republished = save(True, "edited draft")
    assert datetime.fromisoformat(republished["publishedAt"]) > datetime.fromisoformat(
        changed["publishedAt"]
    )


@pytest.mark.parametrize(
    "payload",
    [
        {"enabled": True, "markdown": " \n\t"},
        {"enabled": False, "markdown": "x" * 20_001},
        {"enabled": "true", "markdown": "hello"},
        {"enabled": True, "markdown": "hello", "publishedAt": "2099-01-01T00:00:00Z"},
    ],
)
def test_invalid_updates_leave_the_publication_unchanged(tmp_path, payload):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    assert (
        client.put("/admin/announcement", headers=headers, json=payload).status_code
        == 422
    )
    assert client.get("/api/v2/announcement").json() == {"announcement": None}


def test_publication_timestamp_is_monotonic_even_if_the_clock_moves_back():
    assert (
        next_publication_time("2099-01-01T00:00:00.000Z") == "2099-01-01T00:00:00.001Z"
    )


def test_concurrent_publications_have_distinct_times_and_keep_atomic_content(tmp_path):
    client = make_client(tmp_path)

    async def run():
        service = AnnouncementService(client.app.state.store, client.app.state.redis)
        results = await asyncio.gather(
            *(
                service.update(
                    AnnouncementUpdate(enabled=True, markdown=f"announcement {index}")
                )
                for index in range(3)
            )
        )
        assert len({result.publishedAt for result in results}) == 3
        current = await service.get()
        assert current == max(results, key=lambda result: result.publishedAt)

    asyncio.run(run())
