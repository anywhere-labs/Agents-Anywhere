from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import FastAPI

from aa_control.app import create_app
from aa_control.core.config import ControlSettings, DriveConfig, S3ObjectStoreConfig
from aa_control.infra.object_store import S3ObjectStore
from tests.test_cloud_drive import FakeS3Server


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@dataclass
class DriveEnv:
    app: FastAPI
    client: httpx.AsyncClient
    s3: httpx.AsyncClient
    fake_s3: FakeS3Server
    now: list[int]

    async def register(self, email: str) -> dict[str, str]:
        res = await self.client.post(
            "/auth/register",
            json={"email": email, "password": "password123", "display_name": email.split("@")[0]},
        )
        assert res.status_code in (200, 201), res.text
        return {"Authorization": f"Bearer {res.json()['access_token']}"}

    async def upload(
        self,
        headers: dict[str, str],
        data: bytes,
        *,
        expect: int = 201,
        complete: bool = True,
        **fields: Any,
    ) -> dict[str, Any]:
        body = {"purpose": "transfer", "size_bytes": len(data), "sha256": _sha(data), **fields}
        res = await self.client.post("/drive/uploads", headers=headers, json=body)
        assert res.status_code == expect, res.text
        if expect != 201:
            return res.json()
        created = res.json()
        put = await self.s3.put(created["upload"]["url"], content=data, headers=created["upload"]["headers"])
        assert put.status_code == 200
        if not complete:
            return created
        done = await self.client.post(f"/drive/files/{created['file']['id']}/complete", headers=headers)
        assert done.status_code == 200, done.text
        return done.json()

    async def entries(self, headers: dict[str, str], path: str = "/", expect: int = 200) -> dict[str, Any]:
        res = await self.client.get("/drive/entries", params={"path": path}, headers=headers)
        assert res.status_code == expect, res.text
        return res.json()

    async def resolve(self, headers: dict[str, str], expect: int = 200, **params: str) -> dict[str, Any]:
        res = await self.client.get("/drive/resolve", params=params, headers=headers)
        assert res.status_code == expect, res.text
        return res.json()

    async def mkdir(self, headers: dict[str, str], path: str, expect: int = 201, **extra: Any) -> dict[str, Any]:
        res = await self.client.post("/drive/folders", json={"path": path, **extra}, headers=headers)
        assert res.status_code == expect, res.text
        return res.json()

    async def move_file(self, headers: dict[str, str], file_id: str, path: str, expect: int = 200) -> dict[str, Any]:
        res = await self.client.patch(f"/drive/files/{file_id}", json={"path": path}, headers=headers)
        assert res.status_code == expect, res.text
        return res.json()

    async def move_folder(
        self, headers: dict[str, str], folder_id: str, path: str, expect: int = 200
    ) -> dict[str, Any]:
        res = await self.client.patch(f"/drive/folders/{folder_id}", json={"path": path}, headers=headers)
        assert res.status_code == expect, res.text
        return res.json()

    def object_path(self, upload_url: str) -> str:
        return urlsplit(upload_url).path


@pytest.fixture
async def env(db_engine, redis_client, router_pool, push_provider) -> AsyncIterator[DriveEnv]:
    fake_s3 = FakeS3Server()
    s3_http = httpx.AsyncClient(transport=fake_s3.transport())
    s3_cfg = S3ObjectStoreConfig(
        endpoint="http://minio.internal:9000",
        public_endpoint="https://files.example.test",
        bucket="aa-drive-bucket",
        access_key_id="minioadmin",
        secret_access_key="miniosecret",
    )
    now_ts = [1_800_000_000]
    app = create_app(
        settings=ControlSettings(
            database_url="sqlite+aiosqlite:///:memory:",
            redis_url="redis://localhost:6379/0",
            secret_key="drive-fs-test-secret",
            password_iterations=1_000,
            drive=DriveConfig(default_quota_bytes=1_000_000, default_max_file_bytes=100_000, s3=s3_cfg),
        ),
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        object_store=S3ObjectStore(s3_cfg, http_client=s3_http),
        start_push_worker=False,
        start_drive_cleanup_worker=False,
    )
    app.state.drive_service._now = lambda: now_ts[0]
    try:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="https://aa.example.test",
        ) as client:
            yield DriveEnv(app=app, client=client, s3=s3_http, fake_s3=fake_s3, now=now_ts)
    finally:
        await s3_http.aclose()


def _names(items: list[dict[str, Any]]) -> list[str]:
    return sorted(item["name"] for item in items)


def _content_disposition(download_url: str) -> str:
    return parse_qs(urlsplit(download_url).query)["response-content-disposition"][0]


# ---------------------------------------------------------------------------
# Placement of uploads, listing and resolving
# ---------------------------------------------------------------------------


async def test_transfers_land_in_transfers_folder_and_duplicates_get_suffixes(env: DriveEnv) -> None:
    alice = await env.register("alice@example.com")
    first = await env.upload(alice, b"one", filename="report.pdf", mime_type="application/pdf")
    second = await env.upload(alice, b"two!", filename="report.pdf", mime_type="application/pdf")
    tar_a = await env.upload(alice, b"tar-a", filename="build.tar.gz")
    tar_b = await env.upload(alice, b"tar-bb", filename="build.tar.gz")

    assert first["path"] == "/Transfers/report.pdf"
    assert first["name"] == "report.pdf" and first["parent_path"] == "/Transfers"
    assert first["ref"] == "drive:/Transfers/report.pdf" and first["managed"] is False
    assert second["path"] == "/Transfers/report (1).pdf"
    assert second["filename"] == "report (1).pdf"
    assert second["ref"] == "drive:/Transfers/report%20%281%29.pdf"
    assert tar_a["path"] == "/Transfers/build.tar.gz"
    assert tar_b["path"] == "/Transfers/build (1).tar.gz"

    # The download carries the name the file has in the drive
    dl = (await env.client.get(f"/drive/files/{second['id']}/download-url", headers=alice)).json()
    assert "filename*=UTF-8''report%20%281%29.pdf" in _content_disposition(dl["download"]["url"])

    root = await env.entries(alice, "/")
    assert root["path"] == "/" and root["ref"] == "drive:/" and root["folder"] is None
    assert [(f["path"], f["system"], f["managed"]) for f in root["folders"]] == [("/Transfers", "transfers", False)]
    assert root["files"] == [] and root["total_files"] == 0
    assert root["quota"]["enabled"] is True

    transfers = await env.entries(alice, "/Transfers")
    assert transfers["folder"]["system"] == "transfers"
    assert _names(transfers["files"]) == sorted(
        ["report.pdf", "report (1).pdf", "build.tar.gz", "build (1).tar.gz"]
    )
    assert transfers["total_files"] == 4
    assert all(f["expires_at"] and f["status"] == "ready" for f in transfers["files"])

    page = (
        await env.client.get("/drive/entries", params={"path": "/Transfers", "limit": 3}, headers=alice)
    ).json()
    assert len(page["files"]) == 3 and page["total_files"] == 4


async def test_upload_to_explicit_path_and_resolve_by_path_or_reference(env: DriveEnv) -> None:
    alice = await env.register("alice@example.com")
    q3 = await env.upload(alice, b"q3-figures", path="/报告/2026/q3.pdf", mime_type="application/pdf")
    assert q3["path"] == "/报告/2026/q3.pdf"
    assert q3["filename"] == "q3.pdf"
    assert q3["ref"] == "drive:/报告/2026/q3.pdf"

    reports = await env.entries(alice, "/报告")
    assert reports["folder"]["path"] == "/报告" and reports["folder"]["system"] is None
    assert [(f["path"], f["name"], f["parent_path"]) for f in reports["folders"]] == [("/报告/2026", "2026", "/报告")]
    assert reports["files"] == []

    in_folder = await env.upload(alice, b"notes", folder="报告/2026", filename="notes.md")
    assert in_folder["path"] == "/报告/2026/notes.md"

    for params in (
        {"ref": "drive:/报告/2026/q3.pdf"},
        {"ref": "drive:/%E6%8A%A5%E5%91%8A/2026/q3.pdf"},
        {"path": "报告//2026/q3.pdf"},
    ):
        found = await env.resolve(alice, **params)
        assert found["kind"] == "file" and found["file"]["id"] == q3["id"]
        assert found["path"] == "/报告/2026/q3.pdf" and found["ref"] == "drive:/报告/2026/q3.pdf"

    folder = await env.resolve(alice, path="/报告/2026")
    assert folder["kind"] == "folder" and folder["folder"]["path"] == "/报告/2026" and folder["file"] is None
    root = await env.resolve(alice, ref="drive:/")
    assert root == {"kind": "folder", "path": "/", "ref": "drive:/", "folder": None, "file": None}

    missing = await env.resolve(alice, expect=404, path="/报告/2025/q3.pdf")
    assert missing["code"] == "drive_path_not_found"
    for bad_ref in ("drive:报告/q3.pdf", "drive://other/q3.pdf", "drive:/a?b", "/报告/2026/q3.pdf"):
        assert (await env.resolve(alice, expect=422, ref=bad_ref))["code"] == "drive_invalid_ref"
    assert (await env.client.get("/drive/resolve", headers=alice)).status_code == 422
    both = await env.client.get("/drive/resolve", params={"path": "/a", "ref": "drive:/a"}, headers=alice)
    assert both.status_code == 422

    assert (await env.entries(alice, "/报告/2026/q3.pdf", expect=422))["code"] == "drive_not_a_folder"
    assert (await env.entries(alice, "/nope", expect=404))["code"] == "drive_path_not_found"
    assert (await env.entries(alice, "/a/../b", expect=422))["code"] == "drive_invalid_path"

    bad = await env.upload(alice, b"x", expect=422, path="/a/../etc/passwd")
    assert bad["code"] == "drive_invalid_path"
    both_targets = await env.upload(alice, b"x", expect=422, path="/a.txt", folder="/b")
    assert both_targets["code"] == "drive_invalid_path"


async def test_conflict_policies_on_upload_and_completion(env: DriveEnv) -> None:
    alice = await env.register("alice@example.com")
    first = await env.upload(alice, b"v1", path="/docs/plan.md")

    # fail: refused before any bytes move
    refused = await env.upload(alice, b"v2", expect=409, path="/docs/plan.md", on_conflict="fail")
    assert refused["code"] == "drive_path_conflict"

    # replace: the older file is superseded and its object removed
    first_object = [p for p in env.fake_s3.objects if p.endswith(first["id"])]
    assert len(first_object) == 1
    second = await env.upload(alice, b"v2!", path="/docs/plan.md", on_conflict="replace")
    assert second["path"] == "/docs/plan.md"
    assert (await env.client.get(f"/drive/files/{first['id']}", headers=alice)).status_code == 404
    assert first_object[0] not in env.fake_s3.objects
    assert _names((await env.entries(alice, "/docs"))["files"]) == ["plan.md"]

    # A completion that meets a newcomer stops with 409; the reservation stays and can retry with another policy
    pending = await env.upload(alice, b"draft", path="/docs/notes.md", on_conflict="fail", complete=False)
    assert pending["file"]["status"] == "pending" and pending["file"]["path"] == "/docs/notes.md"
    await env.upload(alice, b"newcomer", path="/docs/notes.md")
    clash = await env.client.post(f"/drive/files/{pending['file']['id']}/complete", headers=alice)
    assert clash.status_code == 409 and clash.json()["code"] == "drive_path_conflict"
    retried = await env.client.post(
        f"/drive/files/{pending['file']['id']}/complete", json={"on_conflict": "rename"}, headers=alice
    )
    assert retried.status_code == 200, retried.text
    assert retried.json()["path"] == "/docs/notes (1).md"

    # A folder is never replaced by a file; rename steps around it
    over_folder = await env.upload(alice, b"x", expect=409, path="/docs", on_conflict="replace")
    assert over_folder["code"] == "drive_path_conflict"
    beside = await env.upload(alice, b"x", path="/docs")
    assert beside["path"] == "/docs (1)"

    # Nothing can be placed below a file
    below_file = await env.upload(alice, b"x", expect=409, path="/docs/plan.md/inner.txt")
    assert below_file["code"] == "drive_parent_is_file"


async def test_expired_files_do_not_block_their_path(env: DriveEnv) -> None:
    alice = await env.register("alice@example.com")
    old = await env.upload(alice, b"short-lived", path="/tmp/report.txt", ttl_seconds=3600)
    old_object = [p for p in env.fake_s3.objects if p.endswith(old["id"])][0]
    env.now[0] += 3601

    assert (await env.entries(alice, "/tmp"))["files"] == []
    assert (await env.resolve(alice, expect=404, path="/tmp/report.txt"))["code"] == "drive_path_not_found"
    fresh = await env.upload(alice, b"fresh", path="/tmp/report.txt", on_conflict="fail")
    assert fresh["path"] == "/tmp/report.txt"

    # The expired file gave its path up as a deleted row; cleanup removes its object, the new file stays
    assert await env.app.state.drive_service.cleanup_expired() == 1
    assert old_object not in env.fake_s3.objects
    assert (await env.resolve(alice, path="/tmp/report.txt"))["file"]["id"] == fresh["id"]


# ---------------------------------------------------------------------------
# Folders, moves and recursive deletes
# ---------------------------------------------------------------------------


async def test_create_folders(env: DriveEnv) -> None:
    alice = await env.register("alice@example.com")
    created = await env.mkdir(alice, "/项目/设计")
    assert created["path"] == "/项目/设计" and created["name"] == "设计" and created["parent_path"] == "/项目"
    assert created["ref"] == "drive:/项目/设计" and created["system"] is None and created["managed"] is False
    assert (await env.resolve(alice, path="/项目"))["kind"] == "folder"

    again = await env.mkdir(alice, "/项目/设计", expect=409)
    assert again["code"] == "drive_path_conflict"
    same = await env.mkdir(alice, "项目/设计/", expect=200, exist_ok=True)
    assert same["id"] == created["id"]

    # Empty folders exist and are listed
    assert [f["path"] for f in (await env.entries(alice, "/项目"))["folders"]] == ["/项目/设计"]
    empty = await env.entries(alice, "/项目/设计")
    assert empty["folders"] == [] and empty["files"] == [] and empty["folder"]["id"] == created["id"]

    await env.upload(alice, b"memo", path="/memo.txt")
    assert (await env.mkdir(alice, "/memo.txt", expect=409))["code"] == "drive_path_conflict"
    assert (await env.mkdir(alice, "/memo.txt/inner", expect=409))["code"] == "drive_parent_is_file"
    assert (await env.mkdir(alice, "/Orches", expect=409))["code"] == "drive_managed_path"
    assert (await env.mkdir(alice, "/Orches/notes", expect=409))["code"] == "drive_managed_path"
    assert (await env.mkdir(alice, "/", expect=422))["code"] == "drive_invalid_path"
    assert (await env.mkdir(alice, "/a/./b", expect=422))["code"] == "drive_invalid_path"
    # /Transfers is an ordinary folder name to create
    assert (await env.mkdir(alice, "/Transfers"))["system"] == "transfers"


async def test_rename_and_move_files(env: DriveEnv) -> None:
    alice = await env.register("alice@example.com")
    bob = await env.register("bob@example.com")
    draft = await env.upload(alice, b"draft text", path="/inbox/draft.txt", mime_type="text/plain")

    renamed = await env.move_file(alice, draft["id"], "/inbox/final.txt")
    assert renamed["path"] == "/inbox/final.txt" and renamed["name"] == "final.txt"
    assert renamed["filename"] == "final.txt"
    assert renamed["expires_at"] == draft["expires_at"] and renamed["ttl_seconds"] == draft["ttl_seconds"]

    moved = await env.move_file(alice, draft["id"], "/archive/2026/final.txt")
    assert moved["parent_path"] == "/archive/2026"
    assert (await env.entries(alice, "/inbox"))["files"] == []
    assert (await env.resolve(alice, path="/archive"))["kind"] == "folder"
    dl = (await env.client.get(f"/drive/files/{draft['id']}/download-url", headers=alice)).json()
    assert "filename*=UTF-8''final.txt" in _content_disposition(dl["download"]["url"])

    other = await env.upload(alice, b"other", path="/archive/2026/other.txt")
    assert (await env.move_file(alice, other["id"], "/archive/2026/final.txt", 409))["code"] == "drive_path_conflict"
    assert (await env.move_file(alice, other["id"], "/archive", 409))["code"] == "drive_path_conflict"
    assert (
        await env.move_file(alice, other["id"], "/archive/2026/final.txt/x.txt", 409)
    )["code"] == "drive_parent_is_file"
    assert (await env.move_file(alice, other["id"], "/Orches/x.txt", 409))["code"] == "drive_managed_path"
    assert (await env.move_file(alice, other["id"], "/", 422))["code"] == "drive_invalid_path"
    same = await env.move_file(alice, other["id"], "archive/2026/other.txt")
    assert same["path"] == "/archive/2026/other.txt"

    # Pending uploads and other accounts' files cannot be moved
    pending = await env.upload(alice, b"pending", path="/inbox/p.txt", complete=False)
    assert (await env.move_file(alice, pending["file"]["id"], "/inbox/q.txt", 404))["code"] == "not_found"
    assert (await env.move_file(bob, other["id"], "/mine.txt", 403))["code"] == "permission_denied"


async def test_move_folder_moves_the_whole_subtree(env: DriveEnv) -> None:
    alice = await env.register("alice@example.com")
    bob = await env.register("bob@example.com")
    a = await env.upload(alice, b"a", path="/proj/a.txt")
    b = await env.upload(alice, b"bb", path="/proj/sub/b.txt")
    await env.mkdir(alice, "/proj/empty")
    pending = await env.upload(alice, b"ccc", path="/proj/sub/c.txt", complete=False)
    proj = (await env.resolve(alice, path="/proj"))["folder"]

    res = await env.move_folder(alice, proj["id"], "/归档/proj-2026")
    assert res["folder"]["id"] == proj["id"]
    assert res["folder"]["path"] == "/归档/proj-2026" and res["folder"]["parent_path"] == "/归档"
    assert res["moved_folders"] == 3 and res["moved_files"] == 3

    moved = await env.entries(alice, "/归档/proj-2026")
    assert [f["path"] for f in sorted(moved["folders"], key=lambda f: f["path"])] == [
        "/归档/proj-2026/empty",
        "/归档/proj-2026/sub",
    ]
    assert [f["id"] for f in moved["files"]] == [a["id"]]
    assert (await env.resolve(alice, path="/归档/proj-2026/sub/b.txt"))["file"]["id"] == b["id"]
    assert (await env.entries(alice, "/proj", expect=404))["code"] == "drive_path_not_found"

    # An upload that was in flight lands in the moved folder
    done = await env.client.post(f"/drive/files/{pending['file']['id']}/complete", headers=alice)
    assert done.status_code == 200 and done.json()["path"] == "/归档/proj-2026/sub/c.txt"

    renamed = await env.move_folder(alice, proj["id"], "/归档/proj-final")
    assert renamed["folder"]["name"] == "proj-final"

    # An upload heading for a folder that does not exist yet does not block a move there; it lands inside
    incoming = await env.upload(alice, b"incoming", path="/归档/landing/in.txt", complete=False)
    landed = await env.move_folder(alice, proj["id"], "/归档/landing")
    assert landed["folder"]["path"] == "/归档/landing"
    done_in = await env.client.post(f"/drive/files/{incoming['file']['id']}/complete", headers=alice)
    assert done_in.status_code == 200 and done_in.json()["path"] == "/归档/landing/in.txt"
    await env.move_folder(alice, proj["id"], "/归档/proj-final")

    assert (
        await env.move_folder(alice, proj["id"], "/归档/proj-final/sub/inner", 422)
    )["code"] == "drive_move_into_self"
    await env.mkdir(alice, "/taken")
    assert (await env.move_folder(alice, proj["id"], "/taken", 409))["code"] == "drive_path_conflict"
    await env.upload(alice, b"f", path="/a-file")
    assert (await env.move_folder(alice, proj["id"], "/a-file", 409))["code"] == "drive_path_conflict"
    assert (await env.move_folder(alice, proj["id"], "/Orches/proj", 409))["code"] == "drive_managed_path"
    assert (await env.move_folder(bob, proj["id"], "/bob", 403))["code"] == "permission_denied"

    await env.upload(alice, b"t", filename="t.bin")
    transfers = (await env.resolve(alice, path="/Transfers"))["folder"]
    assert (await env.move_folder(alice, transfers["id"], "/Old", 409))["code"] == "drive_system_folder"
    missing = await env.client.patch("/drive/folders/dfd_missing", json={"path": "/x"}, headers=alice)
    assert missing.status_code == 404 and missing.json()["code"] == "drive_folder_not_found"


async def test_delete_folder_recursively_and_reclaim_storage(env: DriveEnv) -> None:
    alice = await env.register("alice@example.com")
    bob = await env.register("bob@example.com")
    keep = await env.upload(alice, b"keep me", path="/keep.txt")
    one = await env.upload(alice, b"1" * 100, path="/scratch/x/1.bin")
    two = await env.upload(alice, b"2" * 200, path="/scratch/x/2.bin")
    three = await env.upload(alice, b"3" * 300, path="/scratch/3.bin")
    pending = await env.upload(alice, b"4" * 400, path="/scratch/x/4.bin", complete=False)
    assert (await env.client.get("/drive/quota", headers=alice)).json()["used_bytes"] == 7 + 600
    scratch = (await env.resolve(alice, path="/scratch"))["folder"]

    assert (await env.client.delete(f"/drive/folders/{scratch['id']}", headers=bob)).status_code == 403

    res = await env.client.delete(f"/drive/folders/{scratch['id']}", headers=alice)
    assert res.status_code == 200, res.text
    assert res.json() == {"ok": True, "deleted_folders": 2, "deleted_files": 3}
    for item in (one, two, three):
        assert not any(p.endswith(item["id"]) for p in env.fake_s3.objects)
    assert not any(p.endswith(pending["file"]["id"]) for p in env.fake_s3.objects)
    assert [f["name"] for f in (await env.entries(alice, "/"))["files"]] == ["keep.txt"]
    assert (await env.entries(alice, "/"))["folders"] == []
    assert (await env.resolve(alice, expect=404, path="/scratch/x/1.bin"))["code"] == "drive_path_not_found"
    cancelled = await env.client.post(f"/drive/files/{pending['file']['id']}/complete", headers=alice)
    assert cancelled.status_code == 404
    quota = (await env.client.get("/drive/quota", headers=alice)).json()
    assert quota["used_bytes"] == len(b"keep me") and quota["reserved_bytes"] == 0
    assert keep["id"] in {f["id"] for f in (await env.entries(alice, "/"))["files"]}

    # Storage down: the delete still succeeds; objects are removed later by the cleanup worker
    stuck = await env.upload(alice, b"stuck", path="/later/stuck.bin")
    later = (await env.resolve(alice, path="/later"))["folder"]
    env.fake_s3.fail_delete = True
    res2 = await env.client.delete(f"/drive/folders/{later['id']}", headers=alice)
    assert res2.status_code == 200 and res2.json()["deleted_files"] == 1
    assert any(p.endswith(stuck["id"]) for p in env.fake_s3.objects)
    assert (await env.client.get(f"/drive/files/{stuck['id']}", headers=alice)).status_code == 404
    assert (await env.client.get("/drive/quota", headers=alice)).json()["used_bytes"] == len(b"keep me")
    assert await env.app.state.drive_service.cleanup_expired() == 0
    env.fake_s3.fail_delete = False
    assert await env.app.state.drive_service.cleanup_expired() == 1
    assert not any(p.endswith(stuck["id"]) for p in env.fake_s3.objects)

    # Deleting a single file is soft too: gone at once, object removed right away when storage answers
    gone = await env.client.delete(f"/drive/files/{keep['id']}", headers=alice)
    assert gone.status_code == 200 and gone.json() == {"ok": True}
    assert (await env.client.get(f"/drive/files/{keep['id']}", headers=alice)).status_code == 404
    assert (await env.client.delete(f"/drive/files/{keep['id']}", headers=alice)).status_code == 404


# ---------------------------------------------------------------------------
# Orches workspace (assistant_vfs) and encrypted files
# ---------------------------------------------------------------------------


async def test_orches_workspace_files_mirror_vfs_paths_and_stay_managed(env: DriveEnv) -> None:
    alice = await env.register("alice@example.com")
    v1 = await env.upload(
        alice,
        b"# notes v1",
        purpose="assistant_vfs",
        vfs_path="/workspace/notes.md",
        filename="notes.md",
        mime_type="text/markdown",
    )
    assert v1["vfs_path"] == "workspace/notes.md"
    assert v1["path"] == "/Orches/workspace/notes.md" and v1["managed"] is True
    v1_object = [p for p in env.fake_s3.objects if p.endswith(v1["id"])][0]

    # Writing the same vfs_path again replaces the older version (as before)
    v2 = await env.upload(
        alice,
        b"# notes v2!",
        purpose="assistant_vfs",
        vfs_path="workspace/notes.md",
        filename="notes.md",
        mime_type="text/markdown",
    )
    assert v2["path"] == "/Orches/workspace/notes.md"
    assert (await env.client.get(f"/drive/files/{v1['id']}", headers=alice)).status_code == 404
    assert v1_object not in env.fake_s3.objects
    flat = (
        await env.client.get(
            "/drive/files", params={"purpose": "assistant_vfs", "vfs_prefix": "workspace"}, headers=alice
        )
    ).json()
    assert [f["id"] for f in flat["files"]] == [v2["id"]]

    # Encrypted workspace file without a plaintext vfs_path: named by its id, nothing else is revealed
    sealed = await env.upload(
        alice,
        b"\x01" * 64,
        purpose="assistant_vfs",
        filename="secret-plan.md",
        encryption_mode="account_dek",
        encryption_nonce="YWJjZGVmZ2hpamts",
        encryption_key_version=1,
        encrypted_meta="opaque-meta",
    )
    assert sealed["path"] == f"/Orches/{sealed['id']}" and sealed["filename"] is None
    assert "secret" not in sealed["path"] and "secret" not in sealed["ref"]

    # A vfs_path that collides with a folder still syncs, under its file id
    blocked = await env.upload(
        alice, b"odd", purpose="assistant_vfs", vfs_path="workspace", filename="workspace"
    )
    assert blocked["vfs_path"] == "workspace" and blocked["path"] == f"/Orches/{blocked['id']}"

    root = await env.entries(alice, "/")
    orches = next(f for f in root["folders"] if f["path"] == "/Orches")
    assert orches["system"] == "orches" and orches["managed"] is True
    workspace = await env.entries(alice, "/Orches/workspace")
    assert workspace["folder"]["managed"] is True and workspace["folder"]["system"] is None
    assert [f["id"] for f in workspace["files"]] == [v2["id"]]

    # Only Orches' own sync writes there: no renames, moves, new folders or uploads through the drive API
    assert (await env.move_file(alice, v2["id"], "/Orches/workspace/other.md", 409))["code"] == "drive_managed_path"
    assert (await env.move_file(alice, v2["id"], "/notes.md", 409))["code"] == "drive_managed_path"
    assert (await env.move_folder(alice, workspace["folder"]["id"], "/Orches/ws", 409))["code"] == "drive_managed_path"
    assert (await env.move_folder(alice, orches["id"], "/Bot", 409))["code"] == "drive_system_folder"
    assert (await env.upload(alice, b"x", expect=409, path="/Orches/x.md"))["code"] == "drive_managed_path"
    assert (await env.upload(alice, b"x", expect=409, folder="/Orches"))["code"] == "drive_managed_path"
    bad_path = await env.upload(
        alice, b"x", expect=422, purpose="assistant_vfs", vfs_path="workspace/a.md", path="/a.md"
    )
    assert bad_path["code"] == "drive_invalid_path"
    bad_policy = await env.upload(
        alice, b"x", expect=422, purpose="assistant_vfs", vfs_path="workspace/a.md", on_conflict="fail"
    )
    assert bad_policy["code"] == "drive_invalid_path"

    # ...but they can be downloaded, referenced and deleted, folders included
    assert (await env.resolve(alice, ref=v2["ref"]))["file"]["id"] == v2["id"]
    deleted = await env.client.delete(f"/drive/folders/{workspace['folder']['id']}", headers=alice)
    assert deleted.status_code == 200 and deleted.json()["deleted_files"] == 1
    flat_after = (await env.client.get("/drive/files", params={"purpose": "assistant_vfs"}, headers=alice)).json()
    assert {f["id"] for f in flat_after["files"]} == {sealed["id"], blocked["id"]}


async def test_encrypted_transfers_never_get_a_plaintext_name(env: DriveEnv) -> None:
    alice = await env.register("alice@example.com")
    dev = (
        await env.client.post("/devices/register", headers=alice, json={"name": "Vault box", "platform": "linux"})
    ).json()
    device = {"X-AA-Device-Id": dev["device"]["id"], "X-AA-Device-Secret": dev["device_secret"]}
    sealed_fields = {"encryption_mode": "ephemeral_key", "encryption_nonce": "MTIzNDU2Nzg5MDEy"}

    sealed = await env.upload(device, b"\x02" * 80, filename="secret-plan.pdf", **sealed_fields)
    assert sealed["filename"] is None
    assert sealed["path"] == f"/Transfers/{sealed['id']}" and sealed["name"] == sealed["id"]
    assert "secret" not in sealed["ref"]

    named = await env.upload(device, b"\x02" * 80, expect=422, path="/vault/secret-plan.pdf", **sealed_fields)
    assert named["code"] == "drive_encrypted_name"
    in_folder = await env.upload(device, b"\x03" * 80, folder="/vault", filename="secret.pdf", **sealed_fields)
    assert in_folder["path"] == f"/vault/{in_folder['id']}"

    renamed = await env.move_file(alice, in_folder["id"], "/vault/secret-plan.pdf", 422)
    assert renamed["code"] == "drive_encrypted_name"
    moved = await env.move_file(alice, in_folder["id"], f"/archive/{in_folder['id']}")
    assert moved["path"] == f"/archive/{in_folder['id']}"

    # The device sees the same filesystem with its own credentials
    listing = await env.entries(device, "/archive")
    assert [f["id"] for f in listing["files"]] == [in_folder["id"]]
    assert (await env.resolve(device, ref=moved["ref"]))["file"]["id"] == in_folder["id"]


async def test_accounts_have_separate_namespaces(env: DriveEnv) -> None:
    alice = await env.register("alice@example.com")
    bob = await env.register("bob@example.com")
    mine = await env.upload(alice, b"alice", path="/shared-name.txt")
    theirs = await env.upload(bob, b"bob!", path="/shared-name.txt")
    assert mine["path"] == theirs["path"] == "/shared-name.txt"
    assert (await env.resolve(bob, path="/shared-name.txt"))["file"]["id"] == theirs["id"]
    await env.mkdir(alice, "/private")
    assert (await env.entries(bob, "/private", expect=404))["code"] == "drive_path_not_found"
    folder = (await env.resolve(alice, path="/private"))["folder"]
    assert (await env.client.delete(f"/drive/folders/{folder['id']}", headers=bob)).status_code == 403


async def test_folder_operations_need_the_drive_enabled_for_creation_only(
    db_engine, redis_client, router_pool, push_provider
) -> None:
    app = create_app(
        settings=ControlSettings(
            database_url="sqlite+aiosqlite:///:memory:",
            redis_url="redis://localhost:6379/0",
            secret_key="no-s3",
            password_iterations=1_000,
        ),
        engine=db_engine,
        redis_client=redis_client,
        router_pool=router_pool,
        push_provider=push_provider,
        start_push_worker=False,
        start_drive_cleanup_worker=False,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://aa.example.test") as client:
        reg = (await client.post("/auth/register", json={"email": "u@example.com", "password": "password123"})).json()
        headers = {"Authorization": f"Bearer {reg['access_token']}"}
        listing = (await client.get("/drive/entries", headers=headers)).json()
        assert listing["quota"]["enabled"] is False and listing["folders"] == [] and listing["files"] == []
        res = await client.post("/drive/folders", json={"path": "/a"}, headers=headers)
        assert res.status_code == 503 and res.json()["code"] == "drive_not_configured"
