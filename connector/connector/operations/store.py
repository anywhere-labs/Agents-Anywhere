from __future__ import annotations

import hashlib
import json
import os
import secrets
from pathlib import Path

from connector.operations.models import OperationRecord


class OperationStore:
    """Fail closed on malformed/unwritable receipts; no memory fallback."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)

    def _path(self, operation_id: str) -> Path:
        return self.directory / (
            hashlib.sha256(operation_id.encode()).hexdigest() + ".json"
        )

    def read(self, operation_id: str) -> OperationRecord | None:
        path = self._path(operation_id)
        try:
            value = OperationRecord.model_validate_json(path.read_bytes())
        except FileNotFoundError:
            return None
        if value.request.operationId != operation_id:
            raise ValueError("operation receipt identity mismatch")
        return value

    def records(self) -> list[OperationRecord]:
        return [
            OperationRecord.model_validate_json(path.read_bytes())
            for path in self.directory.glob("*.json")
        ]

    def write(self, record: OperationRecord) -> None:
        path = self._path(record.request.operationId)
        temporary = path.with_suffix(f".{secrets.token_hex(8)}.tmp")
        try:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w", encoding="utf-8") as file:
                json.dump(record.model_dump(), file, ensure_ascii=True)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)
            if os.name != "nt":
                descriptor = os.open(self.directory, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        finally:
            temporary.unlink(missing_ok=True)
