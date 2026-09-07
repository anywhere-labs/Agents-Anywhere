import pytest

from connector.core import runtime_owner


@pytest.fixture(autouse=True)
def isolated_runtime_home(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime_owner, "system_home", lambda: tmp_path / "runtime-home")
    for key in ("AA_CONNECTOR_OWNER_INSTANCE", "AA_CONNECTOR_OWNER_PID", "AA_CONNECTOR_OWNER_KIND"):
        monkeypatch.delenv(key, raising=False)
