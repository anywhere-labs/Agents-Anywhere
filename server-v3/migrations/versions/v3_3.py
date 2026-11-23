"""Turn the cloud drive into a filesystem: absolute paths for files and explicit folders.

Revision ID: v3_3
Revises: v3_2
Create Date: 2026-11-23

- ``drive_files`` gains ``path`` / ``parent_path`` (NOT NULL) and ``on_conflict``. Ready files' paths are unique
  per account (partial unique index); ``status`` gains ``deleted`` (soft-deleted rows whose objects the cleanup
  worker removes).
- New ``drive_folders`` table: explicit folders, so empty folders exist too. The root ``/`` is implicit.
- Backfill of existing files:
  - ``transfer`` files go to ``/Transfers/<filename>``; duplicate names get `` (1)``, `` (2)``… before the
    extension (the oldest file keeps the plain name). Files without a plaintext name (``ephemeral_key`` uploads,
    uploads without ``filename``) are named by their file id, so no name is revealed.
  - ``assistant_vfs`` files go to ``/Orches/<vfs_path>``; files without a ``vfs_path`` (allowed for encrypted
    uploads), whose ``vfs_path`` is no valid drive path, or whose path is blocked go to ``/Orches/<file id>``.
    When an older version of the same ``vfs_path`` is still marked ready (its object delete had failed), the
    newest version keeps the path and the older ones become ``deleted`` rows for the cleanup worker.
  - Pending uploads keep their target path and settle it on completion.
"""

from __future__ import annotations

import secrets
import unicodedata
from collections.abc import Container
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from alembic import op

revision = "v3_3"
down_revision = "v3_2"
branch_labels = None
depends_on = None

TRANSFERS = "/Transfers"
ORCHES = "/Orches"

# ---------------------------------------------------------------------------
# Frozen copy of the path rules in aa_control/core/drive.py at this revision: a migration must keep behaving the
# same when the application code changes later.
# ---------------------------------------------------------------------------

_COMPOUND_EXTENSIONS = (".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tar.lz", ".tar.br")


def _bad_char(ch: str) -> bool:
    return unicodedata.category(ch) in {"Cc", "Cs"}


def _norm_name(raw: str) -> str | None:
    name = unicodedata.normalize("NFC", raw).strip()
    if not name or "/" in name or "\\" in name or name in {".", ".."}:
        return None
    if any(_bad_char(ch) for ch in name) or len(name) > 255:
        return None
    return name


def _norm_path(raw: str) -> str | None:
    names: list[str] = []
    for segment in raw.replace("\\", "/").strip().split("/"):
        if segment == "":
            continue
        name = _norm_name(segment)
        if name is None:
            return None
        names.append(name)
    if len(names) > 32:
        return None
    path = "/" + "/".join(names)
    return path if len(path) <= 1024 else None


def _split(name: str) -> tuple[str, str]:
    lowered = name.lower()
    for ext in _COMPOUND_EXTENSIONS:
        if lowered.endswith(ext) and len(name) > len(ext):
            return name[: -len(ext)], name[-len(ext) :]
    dot = name.rfind(".")
    if dot <= 0:
        return name, ""
    return name[:dot], name[dot:]


def _safe_name(raw: str | None, fallback: str) -> str:
    if raw is None:
        return fallback
    base = unicodedata.normalize("NFC", raw).replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = "".join("_" if _bad_char(ch) else ch for ch in base).strip()
    if not cleaned or cleaned in {".", ".."}:
        return fallback
    if len(cleaned) > 255:
        stem, ext = _split(cleaned)
        if len(ext) > 32:
            stem, ext = cleaned, ""
        cleaned = stem[: 255 - len(ext)].rstrip() + ext
    return cleaned


def _dedupe(name: str, taken: Container[str]) -> str:
    if name not in taken:
        return name
    stem, ext = _split(name)
    if len(ext) > 32:
        stem, ext = name, ""
    n = 1
    while True:
        suffix = f" ({n})"
        room = 255 - len(suffix) - len(ext)
        candidate = f"{stem[:room].rstrip() or stem[:room]}{suffix}{ext}"
        if candidate not in taken:
            return candidate
        n += 1


def _parent(path: str) -> str:
    head = path.rsplit("/", 1)[0]
    return head or "/"


def _basename(path: str) -> str:
    return path.rsplit("/", 1)[-1]


def _ancestors(path: str) -> list[str]:
    names = [segment for segment in path.split("/") if segment]
    return ["/" + "/".join(names[:depth]) for depth in range(1, len(names))]


def _orches_path(vfs_path: str | None, file_id: str) -> str:
    if vfs_path:
        path = _norm_path(f"{ORCHES}/{vfs_path}")
        if path is not None:
            return path
    return f"{ORCHES}/{file_id}"


# ---------------------------------------------------------------------------
# Backfill
# ---------------------------------------------------------------------------

_files = sa.table(
    "drive_files",
    sa.column("id", sa.Text),
    sa.column("user_id", sa.Text),
    sa.column("purpose", sa.Text),
    sa.column("status", sa.Text),
    sa.column("filename", sa.Text),
    sa.column("vfs_path", sa.Text),
    sa.column("encryption_mode", sa.Text),
    sa.column("expires_at", sa.BigInteger),
    sa.column("created_at", sa.Text),
    sa.column("completed_at", sa.Text),
    sa.column("path", sa.Text),
    sa.column("parent_path", sa.Text),
    sa.column("on_conflict", sa.Text),
)
_folders = sa.table(
    "drive_folders",
    sa.column("id", sa.Text),
    sa.column("user_id", sa.Text),
    sa.column("path", sa.Text),
    sa.column("parent_path", sa.Text),
    sa.column("created_at", sa.Text),
    sa.column("updated_at", sa.Text),
)


class _Namespace:
    """One account's paths while backfilling (files placed so far, folders, names per folder)."""

    def __init__(self, user_id: str, now_iso: str, new_folders: list[dict[str, Any]]) -> None:
        self.user_id = user_id
        self.now_iso = now_iso
        self.files: set[str] = set()
        self.folders: set[str] = set()
        self.names: dict[str, set[str]] = {}
        self._new_folders = new_folders

    def blocked(self, path: str) -> bool:
        return path in self.files or path in self.folders or any(a in self.files for a in _ancestors(path))

    def place(self, path: str) -> None:
        for ancestor in _ancestors(path):
            if ancestor in self.folders:
                continue
            self.folders.add(ancestor)
            self.names.setdefault(_parent(ancestor), set()).add(_basename(ancestor))
            self._new_folders.append(
                {
                    "id": f"dfd_{secrets.token_hex(12)}",
                    "user_id": self.user_id,
                    "path": ancestor,
                    "parent_path": _parent(ancestor),
                    "created_at": self.now_iso,
                    "updated_at": self.now_iso,
                }
            )
        self.files.add(path)
        self.names.setdefault(_parent(path), set()).add(_basename(path))


def _sort_key(row: Any) -> tuple[str, str]:
    return (str(row["completed_at"] or row["created_at"] or ""), str(row["id"]))


def _backfill(bind: sa.Connection) -> None:
    rows = (
        bind.execute(
            sa.select(
                _files.c.id,
                _files.c.user_id,
                _files.c.purpose,
                _files.c.status,
                _files.c.filename,
                _files.c.vfs_path,
                _files.c.encryption_mode,
                _files.c.expires_at,
                _files.c.created_at,
                _files.c.completed_at,
            ).where(_files.c.path.is_(None))
        )
        .mappings()
        .all()
    )
    if not rows:
        return

    now = datetime.now(UTC)
    now_iso = now.isoformat().replace("+00:00", "Z")
    now_ts = int(now.timestamp())
    by_user: dict[str, list[Any]] = {}
    for row in rows:
        by_user.setdefault(str(row["user_id"]), []).append(row)

    updates: list[dict[str, Any]] = []
    new_folders: list[dict[str, Any]] = []

    def record(row: Any, path: str, status: str, policy: str | None, filename: str | None) -> None:
        updates.append(
            {
                "b_id": row["id"],
                "b_path": path,
                "b_parent": _parent(path),
                "b_status": status,
                "b_policy": policy,
                "b_filename": filename,
            }
        )

    for user_id, items in by_user.items():
        items.sort(key=_sort_key)
        ns = _Namespace(user_id, now_iso, new_folders)

        # 1. Orches workspace files: the newest ready version of each vfs_path keeps its path.
        orches_ready = [r for r in items if r["purpose"] == "assistant_vfs" and r["status"] == "ready"]
        newest: dict[str, Any] = {}
        for row in orches_ready:
            if row["vfs_path"]:
                newest[str(row["vfs_path"])] = row
        for row in orches_ready:
            target = _orches_path(row["vfs_path"], str(row["id"]))
            if row["vfs_path"] and newest.get(str(row["vfs_path"])) is not row:
                record(row, target, "deleted", None, row["filename"])
                continue
            if ns.blocked(target):
                target = f"{ORCHES}/{row['id']}"
            ns.place(target)
            record(row, target, "ready", None, row["filename"])

        # 2. Transfer files: /Transfers/<name>. Live files first, oldest first so it keeps the plain name; expired
        #    files the cleanup has not removed yet come last, so a leftover never pushes a live file to "name (1)".
        transfers = [r for r in items if r["purpose"] != "assistant_vfs" and r["status"] == "ready"]
        transfers.sort(key=lambda r: (int(r["expires_at"] or 0) <= now_ts, _sort_key(r)))
        for row in transfers:
            plain = row["encryption_mode"] == "none"
            leaf = _safe_name(row["filename"] if plain else None, str(row["id"]))
            name = _dedupe(leaf, ns.names.get(TRANSFERS, set()))
            path = f"{TRANSFERS}/{name}"
            ns.place(path)
            record(row, path, "ready", None, name if plain and row["filename"] is not None else row["filename"])

        # 3. Pending uploads (and anything else) keep a target path; completion settles it.
        for row in items:
            if row["status"] == "ready":
                continue
            if row["purpose"] == "assistant_vfs":
                target = _orches_path(row["vfs_path"], str(row["id"]))
                policy = "replace" if row["vfs_path"] else "rename"
            else:
                plain = row["encryption_mode"] == "none"
                target = f"{TRANSFERS}/{_safe_name(row['filename'] if plain else None, str(row['id']))}"
                policy = "rename"
            record(row, target, str(row["status"]), policy, row["filename"])

    if new_folders:
        bind.execute(sa.insert(_folders), new_folders)
    bind.execute(
        sa.update(_files)
        .where(_files.c.id == sa.bindparam("b_id"))
        .values(
            path=sa.bindparam("b_path"),
            parent_path=sa.bindparam("b_parent"),
            status=sa.bindparam("b_status"),
            on_conflict=sa.bindparam("b_policy"),
            filename=sa.bindparam("b_filename"),
        ),
        updates,
    )


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "drive_folders" not in tables:
        op.create_table(
            "drive_folders",
            sa.Column("id", sa.Text(), primary_key=True),
            sa.Column("user_id", sa.Text(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("path", sa.Text(), nullable=False),
            sa.Column("parent_path", sa.Text(), nullable=False),
            sa.Column("created_at", sa.Text(), nullable=False),
            sa.Column("updated_at", sa.Text(), nullable=False),
        )
        op.create_index("uq_drive_folders_user_path", "drive_folders", ["user_id", "path"], unique=True)
        op.create_index("idx_drive_folders_user_parent", "drive_folders", ["user_id", "parent_path"])

    columns = {column["name"] for column in inspector.get_columns("drive_files")}
    for name in ("path", "parent_path", "on_conflict"):
        if name not in columns:
            op.add_column("drive_files", sa.Column(name, sa.Text()))

    _backfill(bind)

    with op.batch_alter_table("drive_files") as batch:
        batch.alter_column("path", existing_type=sa.Text(), nullable=False)
        batch.alter_column("parent_path", existing_type=sa.Text(), nullable=False)

    indexes = {index["name"] for index in sa.inspect(bind).get_indexes("drive_files")}
    if "idx_drive_files_user_parent" not in indexes:
        op.create_index("idx_drive_files_user_parent", "drive_files", ["user_id", "parent_path", "status"])
    if "uq_drive_files_user_path_ready" not in indexes:
        op.create_index(
            "uq_drive_files_user_path_ready",
            "drive_files",
            ["user_id", "path"],
            unique=True,
            postgresql_where=sa.text("status = 'ready'"),
            sqlite_where=sa.text("status = 'ready'"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())

    if "drive_files" in tables:
        # v3_2 does not know soft-deleted rows: hand them to its cleanup as expired upload reservations, which
        # removes their objects and rows.
        bind.execute(
            sa.text("UPDATE drive_files SET status = 'pending', upload_expires_at = 0 WHERE status = 'deleted'")
        )
        indexes = {index["name"] for index in inspector.get_indexes("drive_files")}
        for name in ("uq_drive_files_user_path_ready", "idx_drive_files_user_parent"):
            if name in indexes:
                op.drop_index(name, table_name="drive_files")
        columns = {column["name"] for column in inspector.get_columns("drive_files")}
        with op.batch_alter_table("drive_files") as batch:
            for name in ("on_conflict", "parent_path", "path"):
                if name in columns:
                    batch.drop_column(name)

    if "drive_folders" in tables:
        op.drop_table("drive_folders")
