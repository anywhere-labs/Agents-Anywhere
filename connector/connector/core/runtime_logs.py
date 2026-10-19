"""Connector-owned rotating JSONL journal with durable acknowledgements."""
from __future__ import annotations

import json
import os
import threading
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any


class RuntimeLogStore:
    def __init__(self, directory: Path | None = None, *, max_rows: int = 10000,
                 max_bytes: int = 32 * 1024 * 1024, max_age: float = 7 * 86400) -> None:
        self.directory = directory
        self.max_rows, self.max_bytes, self.max_age = max_rows, max_bytes, max_age
        self.condition = threading.Condition(threading.RLock())
        self.closed = False
        self._segments: list[tuple[Path | None, list[dict[str, Any]]]] = []
        self._sequence = 0
        self._seen: set[tuple[str, str]] = set()
        self._version: str | None = None
        if directory:
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            directory.chmod(0o700)
            with self._transaction():
                self._prune()

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        """RPC hosts can coexist before claiming runtime ownership.

        Serialize file operations across processes as well as sink threads; a
        state token invalidates the cache when another Connector writes/clears.
        """
        with self.condition:
            if self.closed:
                raise RuntimeError("Runtime log store is closed")
            if not self.directory:
                yield
                return
            fd = os.open(self.directory / "journal.lock", os.O_CREAT | os.O_RDWR, 0o600)
            with os.fdopen(fd, "rb+") as lock:
                if os.name == "nt":
                    import msvcrt
                    if not lock.read(1):
                        lock.write(b"0")
                        lock.flush()
                    lock.seek(0)
                    msvcrt.locking(lock.fileno(), msvcrt.LK_LOCK, 1)
                else:
                    import fcntl
                    fcntl.flock(lock, fcntl.LOCK_EX)
                try:
                    state, recovered = self._read_state()
                    if recovered or state["version"] != self._version:
                        self._load(state)
                        if recovered:
                            # Persist the repaired state so every later process
                            # does not re-read the damaged file.
                            self._save_state()
                    yield
                except BaseException:
                    self._version = None  # recover the journal before the next use
                    raise
                finally:
                    if os.name == "nt":
                        lock.seek(0)
                        msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
                    else:
                        fcntl.flock(lock, fcntl.LOCK_UN)

    def _read_state(self) -> tuple[dict[str, Any], bool]:
        assert self.directory is not None
        path = self.directory / "state.json"
        try:
            state = json.loads(path.read_text()) if path.exists() else {"seq": 0, "version": "initial"}
            if (not isinstance(state, dict) or not isinstance(state.get("seq"), int)
                    or not isinstance(state.get("version"), str)):
                raise TypeError("invalid runtime log state")
            return state, False
        except (OSError, ValueError, TypeError):
            # A damaged state file (or one left by another product) must not
            # make the Connector unstartable: recover the sequence from the
            # surviving segments and rewrite a valid state below.
            return {"seq": 0, "version": f"recovered-{uuid.uuid4().hex}"}, True

    def _load(self, state: dict[str, Any]) -> None:
        assert self.directory is not None
        self._segments.clear()
        self._sequence = state["seq"]
        for path in sorted(self.directory.glob("runtime-*.jsonl")):
            rows: list[dict[str, Any]] = []
            with path.open("rb+") as file:
                valid_end = 0
                while line := file.readline():
                    try:
                        batch = json.loads(line)
                        if not line.endswith(b"\n") or not isinstance(batch, list):
                            raise ValueError("incomplete log batch")
                        for row in batch:
                            if not isinstance(row, dict) or not isinstance(row.get("seq"), int):
                                raise TypeError("invalid log sequence")
                        rows.extend(batch)
                        valid_end = file.tell()
                    except (ValueError, KeyError, TypeError):
                        # A torn tail and a damaged middle are both recovered by
                        # keeping every batch before the damage. Refusing to load
                        # here would make the Connector unstartable on every retry.
                        file.truncate(valid_end)
                        file.flush()
                        os.fsync(file.fileno())
                        break
            if rows:
                self._sequence = max(self._sequence, rows[-1]["seq"])
                self._segments.append((path, rows))
            else:
                path.unlink()
        self._version = state["version"]
        self._index()

    def _index(self) -> None:
        self._seen = {(row["producer"], row["eventId"]) for _, rows in self._segments
                      for row in rows if row.get("producer")}

    def _sync_directory(self) -> None:
        if self.directory and os.name != "nt":
            fd = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)

    def _save_state(self, *, durable: bool = True) -> None:
        self._version = uuid.uuid4().hex
        if self.directory:
            temporary = self.directory / "state.tmp"
            with temporary.open("w", encoding="utf-8") as file:
                temporary.chmod(0o600)
                json.dump({"seq": self._sequence, "version": self._version}, file)
                file.flush()
                if durable:
                    os.fsync(file.fileno())
            temporary.replace(self.directory / "state.json")
            if durable:
                self._sync_directory()

    def _prune(self, *, durable: bool = True) -> None:
        cutoff = time.time() - self.max_age
        count = sum(len(rows) for _, rows in self._segments)
        size = sum(sum(row["size"] for row in rows) for _, rows in self._segments)
        changed = False
        while self._segments:
            path, rows = self._segments[0]
            if count <= self.max_rows and size <= self.max_bytes and rows[-1]["received"] >= cutoff:
                break
            if not changed:
                self._save_state(durable=durable)
            if path:
                path.unlink(missing_ok=True)
            self._segments.pop(0)
            count -= len(rows)
            size -= sum(row["size"] for row in rows)
            changed = True
        if changed:
            self._index()
            if durable:
                self._sync_directory()

    def append(self, records: list[dict[str, Any]], *, durable: bool = True) -> int:
        """Append records; ``durable=False`` keeps the atomic state/segment
        writes but skips fsync for records nobody acknowledged (connector logs)."""
        with self._transaction():
            self._prune(durable=durable)
            seen = set(self._seen)
            batch: list[dict[str, Any]] = []
            for record in records:
                key = (record.get("producer"), record.get("eventId"))
                if key[0] and key in seen:
                    continue
                seen.add(key)
                row = {**record, "seq": self._sequence + len(batch) + 1, "received": time.time()}
                row["size"] = len(json.dumps(row, ensure_ascii=False).encode())
                batch.append(row)
            if not batch:
                return 0
            self._sequence = batch[-1]["seq"]
            # Reserve the sequence atomically before append, so failures cannot
            # reuse cursors. The replace is visible across processes even when
            # the fsync is skipped.
            self._save_state(durable=durable)
            encoded = (json.dumps(batch, ensure_ascii=False) + "\n").encode()
            segment_limit = min(2 * 1024 * 1024, self.max_bytes)
            if (not self._segments or len(self._segments[-1][1]) + len(batch) > min(1000, self.max_rows)
                or sum(row["size"] for row in self._segments[-1][1]) + len(encoded) > segment_limit):
                path = self.directory / f"runtime-{batch[0]['seq']:020}.jsonl" if self.directory else None
                self._segments.append((path, []))
            path, rows = self._segments[-1]
            if path:
                fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o600)
                with os.fdopen(fd, "ab") as file:
                    file.write(encoded)
                    file.flush()
                    if durable:
                        os.fsync(file.fileno())
                if durable:
                    self._sync_directory()
            rows.extend(batch)
            self._seen = seen
            self._prune(durable=durable)
            self.condition.notify_all()
            return len(batch)

    def rows(self) -> list[dict[str, Any]]:
        with self._transaction():
            self._prune(durable=False)
            return [row for _, rows in self._segments for row in rows]

    def first_seq(self) -> int | None:
        """The oldest retained sequence, without copying the journal."""
        with self._transaction():
            self._prune(durable=False)
            for _, rows in self._segments:
                if rows:
                    return rows[0]["seq"]
            return None

    def clear(self) -> None:
        with self._transaction():
            self._save_state()
            for path, _ in self._segments:
                if path:
                    path.unlink(missing_ok=True)
            self._segments.clear()
            self._seen.clear()
            self._save_state()

    def wait(self) -> bool:
        with self.condition:
            if not self.closed:
                self.condition.wait(0.5)
            return not self.closed

    def close(self) -> None:
        with self.condition:
            self.closed = True
            self.condition.notify_all()
