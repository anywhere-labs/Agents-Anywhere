import os

import pytest

from connector.core import runtime_owner


@pytest.fixture(autouse=True)
def isolated_runtime_home(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime_owner, "system_home", lambda: tmp_path / "runtime-home")
    # In-process controller fixtures run inside pytest, not a Connector CLI.
    # Real subprocess tests exercise the unmodified process identification.
    inspect_pid = runtime_owner._pid_alive

    def inspect_fixture_pid(pid, identity=None):
        if pid == os.getpid():
            return not identity or identity == runtime_owner.process_identity(pid)
        return inspect_pid(pid, identity)

    monkeypatch.setattr(runtime_owner, "_pid_alive", inspect_fixture_pid)
    for key in ("AA_CONNECTOR_OWNER_INSTANCE", "AA_CONNECTOR_OWNER_PID", "AA_CONNECTOR_OWNER_KIND"):
        monkeypatch.delenv(key, raising=False)
