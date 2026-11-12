"""Fence for Server-driven runtime configuration switches.

The Server switches a runtime's model connection as a recoverable transaction
and numbers every attempt with a monotonically increasing ``switchRevision``.
A delayed or replayed request from an earlier attempt must not overwrite a
later one, including after the Connector restarts, so the last accepted
revision is kept on disk per runtime instance.

The start result reports ``configDigest`` (what the running instance actually
loaded) and ``instanceId`` (this Connector process), so the Server can verify
a switch without reading the configuration back.

See docs/api/model-config.md「当前渠道与切换」and the Runtime Control 2.1
contract.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from connector.logging import logger
from connector.runtime_protocol.errors import RuntimeConflictError
from connector.runtime_protocol.instance_models import MAX_CONFIG_REVISION
from connector.runtime_protocol.model_connection import ModelConnectionCapability

SWITCH_FENCE_FEATURE = "switchFence"
CHANNEL_RECONCILE_FENCE_FEATURE = "channelReconcileFence"
MAX_OPERATION_ID_LENGTH = 128
SWITCH_RECORD_VERSION = 1

# One identity per Connector process: a restarted Connector reports a new one.
CONNECTOR_PROCESS_INSTANCE_ID = str(uuid.uuid4())

_SAFE_FILE_NAME = re.compile(r"^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$")


class SwitchRevisionStaleError(RuntimeConflictError):
    """A switch request older than (or conflicting with) the accepted one."""

    code = "switch_revision_stale"


@dataclass(frozen=True, slots=True)
class RuntimeSwitchRequest:
    operation_id: str
    switch_revision: int

    def __post_init__(self) -> None:
        if (
            not isinstance(self.operation_id, str)
            or not 1 <= len(self.operation_id) <= MAX_OPERATION_ID_LENGTH
        ):
            raise ValueError(
                f"operationId must be a string of 1 to {MAX_OPERATION_ID_LENGTH} characters"
            )
        if (
            isinstance(self.switch_revision, bool)
            or not isinstance(self.switch_revision, int)
            or not 1 <= self.switch_revision <= MAX_CONFIG_REVISION
        ):
            raise ValueError(
                f"switchRevision must be between 1 and {MAX_CONFIG_REVISION}"
            )


@dataclass(frozen=True, slots=True)
class RuntimeSwitchRecord:
    switch_revision: int
    operation_id: str
    config_digest: str | None
    status: str
    at: str

    def payload(self) -> dict[str, Any]:
        return {
            "version": SWITCH_RECORD_VERSION,
            "switchRevision": self.switch_revision,
            "operationId": self.operation_id,
            "configDigest": self.config_digest,
            "status": self.status,
            "at": self.at,
        }

    @classmethod
    def from_payload(cls, value: Any) -> RuntimeSwitchRecord:
        if not isinstance(value, dict) or value.get("version") != SWITCH_RECORD_VERSION:
            raise ValueError("unsupported runtime switch record")
        request = RuntimeSwitchRequest(
            operation_id=value.get("operationId"),  # type: ignore[arg-type]
            switch_revision=value.get("switchRevision"),  # type: ignore[arg-type]
        )
        digest = value.get("configDigest")
        status = value.get("status")
        at = value.get("at")
        if digest is not None and not isinstance(digest, str):
            raise TypeError("configDigest must be a string or null")
        if not isinstance(status, str) or not isinstance(at, str):
            raise TypeError("status and at must be strings")
        return cls(
            switch_revision=request.switch_revision,
            operation_id=request.operation_id,
            config_digest=digest,
            status=status,
            at=at,
        )


def model_connection_digest(
    values: Mapping[str, Any] | None,
    capability: ModelConnectionCapability | None,
) -> str | None:
    """Digest of the model connection in ``values``, or None when there is none.

    Mirrors the Server's ``connection_digest`` byte for byte: the gateway
    object (including the key, which only enters through the one-way hash)
    and the model list, as canonical JSON.
    """

    if values is None or capability is None:
        return None
    gateway = values.get(capability.config_field)
    if not isinstance(gateway, dict) or not gateway.get("baseUrl"):
        return None
    models_field = capability.models_field
    material = {
        "gateway": gateway,
        "models": values.get(models_field) if isinstance(models_field, str) else None,
    }
    encoded = json.dumps(
        material,
        sort_keys=True,
        ensure_ascii=False,
        separators=(",", ":"),
    )
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def safe_file_stem(value: str) -> str:
    """A file-name-safe stem; unusual identifiers are hashed instead of escaped."""

    if _SAFE_FILE_NAME.match(value):
        return value
    return "h_" + hashlib.sha256(value.encode("utf-8")).hexdigest()


DirectorySource = Path | Callable[[], Path] | None


class RuntimeSwitchFenceStore:
    """Last accepted switch per runtime instance, one JSON file each.

    ``directory=None`` keeps records in memory only (tests and embedded
    supervisors). Records are cached after the first read; the supervisor
    serializes access per runtime instance.
    """

    def __init__(self, directory: DirectorySource = None) -> None:
        self._directory_source = directory
        self._directory: Path | None = None
        self._records: dict[str, RuntimeSwitchRecord | None] = {}
        self._guard = threading.Lock()

    def check(self, runtime_id: str, request: RuntimeSwitchRequest) -> None:
        """Raise ``SwitchRevisionStaleError`` unless ``request`` may proceed."""

        accepted = self.load(runtime_id)
        if accepted is None:
            return
        if request.switch_revision < accepted.switch_revision:
            raise SwitchRevisionStaleError(
                f"switchRevision {request.switch_revision} is older than the "
                f"accepted switchRevision {accepted.switch_revision} for runtime "
                f"instance {runtime_id!r}"
            )
        if (
            request.switch_revision == accepted.switch_revision
            and request.operation_id != accepted.operation_id
        ):
            raise SwitchRevisionStaleError(
                f"switchRevision {request.switch_revision} was already accepted "
                f"for another operation on runtime instance {runtime_id!r}"
            )

    def is_retry(self, runtime_id: str, request: RuntimeSwitchRequest) -> bool:
        """Whether ``request`` repeats the accepted switch (same revision and operation)."""

        accepted = self.load(runtime_id)
        return (
            accepted is not None
            and accepted.switch_revision == request.switch_revision
            and accepted.operation_id == request.operation_id
        )

    def accept(
        self,
        runtime_id: str,
        request: RuntimeSwitchRequest,
        *,
        config_digest: str | None,
        status: str,
    ) -> RuntimeSwitchRecord:
        record = RuntimeSwitchRecord(
            switch_revision=request.switch_revision,
            operation_id=request.operation_id,
            config_digest=config_digest,
            status=status,
            at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        )
        with self._guard:
            # Memory first: the fence holds in this process even if the write fails.
            self._records[runtime_id] = record
        path = self._path(runtime_id)
        if path is not None:
            try:
                _write_record(path, record)
            except OSError:
                logger.exception(
                    "runtime switch record could not be saved runtime_id={}",
                    runtime_id,
                )
        return record

    def load(self, runtime_id: str) -> RuntimeSwitchRecord | None:
        with self._guard:
            if runtime_id in self._records:
                return self._records[runtime_id]
        record = self._read(runtime_id)
        with self._guard:
            return self._records.setdefault(runtime_id, record)

    def _read(self, runtime_id: str) -> RuntimeSwitchRecord | None:
        path = self._path(runtime_id)
        if path is None:
            return None
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return None
        try:
            return RuntimeSwitchRecord.from_payload(json.loads(raw))
        except (ValueError, TypeError) as exc:
            # An unreadable record must not block every later switch; the
            # Server still verifies the result of the next one.
            logger.warning(
                "ignoring unreadable runtime switch record path={} error={}",
                path,
                exc,
            )
            return None

    def _path(self, runtime_id: str) -> Path | None:
        if self._directory is None:
            source = self._directory_source
            if source is None:
                return None
            self._directory = source() if callable(source) else source
        return self._directory / f"{safe_file_stem(runtime_id)}.json"


def _write_record(path: Path, record: RuntimeSwitchRecord) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(record.payload(), temporary, ensure_ascii=False, indent=2, sort_keys=True)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        temporary_path.chmod(0o600)
        os.replace(temporary_path, path)
    finally:
        if temporary_path is not None and temporary_path.exists():
            temporary_path.unlink()
