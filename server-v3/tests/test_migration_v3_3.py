from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest
import sqlalchemy as sa
from alembic import command
from alembic.config import Config

ALEMBIC_INI = Path(__file__).parents[1] / "alembic.ini"
NOW = 1_800_000_000


def _alembic(conn: sa.Connection, action: str, revision: str) -> None:
    cfg = Config(str(ALEMBIC_INI))
    cfg.set_main_option("script_location", str(ALEMBIC_INI.parent / "migrations"))
    cfg.attributes["connection"] = conn
    getattr(command, action)(cfg, revision)


def _file(file_id: str, user_id: str, **overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "id": file_id,
        "user_id": user_id,
        "purpose": "transfer",
        "status": "ready",
        "object_key": f"aa-drive/u/{user_id}/{file_id}",
        "size_bytes": 10,
        "sha256": "0" * 64,
        "filename": None,
        "mime_type": None,
        "vfs_path": None,
        "encryption_mode": "none",
        "ttl_seconds": 604_800,
        "upload_expires_at": NOW + 900,
        "expires_at": NOW + 604_800,
        "created_at": "2026-11-01T00:00:00Z",
        "completed_at": "2026-11-01T00:00:00Z",
        "updated_at": "2026-11-01T00:00:00Z",
    }
    row.update(overrides)
    return row


def _seed(conn: sa.Connection) -> None:
    for uid in ("usr_1", "usr_2"):
        conn.execute(
            sa.text(
                "INSERT INTO users (id, password_hash, role, disabled, email, display_name, created_at, updated_at) "
                "VALUES (:id, 'x', 'member', 0, :email, :id, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
            ),
            {"id": uid, "email": f"{uid}@example.com"},
        )
    rows = [
        # Two transfers with the same name: the older one keeps it
        _file("t_new", "usr_1", filename="report.pdf", completed_at="2026-11-02T00:00:00Z"),
        _file("t_old", "usr_1", filename="report.pdf", completed_at="2026-11-01T00:00:00Z"),
        # Older still, but expired and not cleaned up yet: it must not take the plain name from a live file
        _file("t_stale", "usr_1", filename="report.pdf", completed_at="2026-10-01T00:00:00Z", expires_at=1_000_000_000),
        # Sealed transfer for an encrypted device (no plaintext name) and a plaintext one without a name
        _file("t_sealed", "usr_1", encryption_mode="ephemeral_key", encryption_nonce="MTIzNDU2Nzg5MDEy"),
        _file("t_anon", "usr_1"),
        # Upload still in flight
        _file("t_pending", "usr_1", status="pending", filename="upload.bin", completed_at=None),
        # Orches workspace: two ready versions of the same vfs_path (the older one's delete had failed)
        _file("a_v1", "usr_1", purpose="assistant_vfs", vfs_path="workspace/notes.md", filename="notes.md"),
        _file(
            "a_v2",
            "usr_1",
            purpose="assistant_vfs",
            vfs_path="workspace/notes.md",
            filename="notes.md",
            completed_at="2026-11-03T00:00:00Z",
        ),
        # Encrypted without a vfs_path, a vfs_path that is no valid drive path, and one colliding with a folder
        _file(
            "a_sealed",
            "usr_1",
            purpose="assistant_vfs",
            encryption_mode="account_dek",
            encryption_nonce="YWJjZGVmZ2hpamts",
            encryption_key_version=1,
            encrypted_meta="opaque",
        ),
        _file("a_odd", "usr_1", purpose="assistant_vfs", vfs_path="workspace/bad\x01name.md"),
        _file(
            "a_clash",
            "usr_1",
            purpose="assistant_vfs",
            vfs_path="workspace",
            completed_at="2026-11-04T00:00:00Z",
        ),
        _file(
            "a_pending",
            "usr_1",
            purpose="assistant_vfs",
            status="pending",
            vfs_path="workspace/todo.md",
            completed_at=None,
        ),
        # Another account: its own namespace
        _file("t_other", "usr_2", filename="report.pdf"),
    ]
    columns = sorted({key for row in rows for key in row})
    stmt = sa.text(
        f"INSERT INTO drive_files ({', '.join(columns)}) VALUES ({', '.join(':' + c for c in columns)})"
    )
    for row in rows:
        conn.execute(stmt, {c: row.get(c) for c in columns})


def _files(conn: sa.Connection) -> dict[str, dict[str, Any]]:
    rows = conn.execute(
        sa.text("SELECT id, status, path, parent_path, on_conflict, filename, vfs_path FROM drive_files")
    ).mappings()
    return {str(r["id"]): dict(r) for r in rows}


def _run_scenario(engine: sa.Engine) -> None:
    with engine.begin() as conn:
        _alembic(conn, "upgrade", "v3_2")
    with engine.begin() as conn:
        _seed(conn)
    with engine.begin() as conn:
        _alembic(conn, "upgrade", "head")

    with engine.connect() as conn:
        files = _files(conn)
        folders = {
            (str(r["user_id"]), str(r["path"])): str(r["parent_path"])
            for r in conn.execute(sa.text("SELECT user_id, path, parent_path FROM drive_folders")).mappings()
        }

    def at(file_id: str) -> tuple[str, str]:
        return files[file_id]["path"], files[file_id]["status"]

    assert at("t_old") == ("/Transfers/report.pdf", "ready")
    assert at("t_new") == ("/Transfers/report (1).pdf", "ready")
    assert files["t_new"]["filename"] == "report (1).pdf"
    assert files["t_new"]["parent_path"] == "/Transfers"
    assert at("t_stale") == ("/Transfers/report (2).pdf", "ready")
    assert at("t_sealed") == ("/Transfers/t_sealed", "ready") and files["t_sealed"]["filename"] is None
    assert at("t_anon") == ("/Transfers/t_anon", "ready") and files["t_anon"]["filename"] is None
    assert at("t_pending") == ("/Transfers/upload.bin", "pending")
    assert files["t_pending"]["on_conflict"] == "rename"

    assert at("a_v2") == ("/Orches/workspace/notes.md", "ready")
    assert at("a_v1") == ("/Orches/workspace/notes.md", "deleted")
    assert files["a_v2"]["vfs_path"] == "workspace/notes.md"
    assert at("a_sealed") == ("/Orches/a_sealed", "ready")
    assert at("a_odd") == ("/Orches/a_odd", "ready")
    assert at("a_clash") == ("/Orches/a_clash", "ready")
    assert at("a_pending") == ("/Orches/workspace/todo.md", "pending")
    assert files["a_pending"]["on_conflict"] == "replace"
    assert at("t_other") == ("/Transfers/report.pdf", "ready")

    assert folders == {
        ("usr_1", "/Transfers"): "/",
        ("usr_1", "/Orches"): "/",
        ("usr_1", "/Orches/workspace"): "/Orches",
        ("usr_2", "/Transfers"): "/",
    }

    # Ready paths are unique per account from now on
    with pytest.raises(sa.exc.IntegrityError), engine.begin() as conn:
        conn.execute(sa.text("UPDATE drive_files SET path = '/Transfers/report.pdf' WHERE id = 't_new'"))
    # ...and NOT NULL
    with pytest.raises(sa.exc.IntegrityError), engine.begin() as conn:
        conn.execute(sa.text("UPDATE drive_files SET path = NULL WHERE id = 't_new'"))

    # Downgrade: columns and folders go; soft-deleted rows become expired reservations v3_2's cleanup removes
    with engine.begin() as conn:
        _alembic(conn, "downgrade", "v3_2")
    inspector = sa.inspect(engine)
    assert "drive_folders" not in inspector.get_table_names()
    columns = {c["name"] for c in inspector.get_columns("drive_files")}
    assert not columns & {"path", "parent_path", "on_conflict"}
    with engine.connect() as conn:
        a_v1 = conn.execute(
            sa.text("SELECT status, upload_expires_at FROM drive_files WHERE id = 'a_v1'")
        ).mappings().one()
    assert a_v1["status"] == "pending" and a_v1["upload_expires_at"] == 0

    # And up again
    with engine.begin() as conn:
        _alembic(conn, "upgrade", "head")
    with engine.connect() as conn:
        again = _files(conn)
    assert again["t_old"]["path"] == "/Transfers/report.pdf"
    assert again["a_v2"]["path"] == "/Orches/workspace/notes.md"


def test_v3_3_backfills_paths_on_sqlite(tmp_path: Path) -> None:
    engine = sa.create_engine(f"sqlite:///{tmp_path / 'v3_3.sqlite'}")
    try:
        _run_scenario(engine)
    finally:
        engine.dispose()


def test_v3_3_backfills_paths_on_postgres() -> None:
    pg_url = os.environ.get("AA_CONTROL_TEST_DB_URL")
    if not pg_url:
        pytest.skip("AA_CONTROL_TEST_DB_URL is not set")
    assert "test" in pg_url.lower()
    engine = sa.create_engine(pg_url.replace("postgresql+asyncpg://", "postgresql+psycopg://"))
    try:
        with engine.begin() as conn:
            conn.execute(sa.text("DROP SCHEMA public CASCADE; CREATE SCHEMA public;"))
        _run_scenario(engine)
    finally:
        engine.dispose()
