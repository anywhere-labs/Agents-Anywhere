from __future__ import annotations

import pytest
from agent_server import app
from agent_server.core.process_settings import ProcessSettings


def test_multi_worker_launcher_and_unique_rpc_identity(monkeypatch):
    monkeypatch.setenv("AGENT_SERVER_WORKERS", "4")
    monkeypatch.setenv("AGENT_SERVER_EVENT_WORKERS", "2")
    monkeypatch.setenv("AGENT_SERVER_REDIS_URL", "redis://unused-in-headless-test/0")
    monkeypatch.setenv("AGENT_SERVER_INSTANCE_ID", "production")
    calls = []
    monkeypatch.setattr(
        app.uvicorn, "run", lambda target, **kwargs: calls.append((target, kwargs))
    )
    app.main()
    assert calls[0][0] == "agent_server.app:create_app"
    assert calls[0][1]["workers"] == 4
    assert calls[0][1]["factory"] is True
    settings = ProcessSettings.from_environment()
    assert settings.event_workers == 2
    monkeypatch.setattr(app.os, "getpid", lambda: 123)
    assert settings.instance_id() == "production-123"
    monkeypatch.setattr(app.os, "getpid", lambda: 456)
    assert settings.instance_id() == "production-456"


@pytest.mark.parametrize("single_instance", [False, True])
def test_multi_worker_rejects_process_local_coordination(monkeypatch, single_instance):
    monkeypatch.setenv("AGENT_SERVER_WORKERS", "4")
    if single_instance:
        monkeypatch.setenv(
            "AGENT_SERVER_REDIS_URL", "redis://unused-in-headless-test/0"
        )
        monkeypatch.setenv("AGENT_SERVER_TIMELINE_SINGLE_INSTANCE", "true")
    monkeypatch.setattr(
        app.uvicorn,
        "run",
        lambda *args, **kwargs: pytest.fail("must reject before starting"),
    )
    with pytest.raises(ValueError, match="requires|cannot be used"):
        app.main()


@pytest.mark.parametrize(
    "name,value", [("AGENT_SERVER_WORKERS", "0"), ("AGENT_SERVER_EVENT_WORKERS", "-1")]
)
def test_invalid_process_counts_are_rejected(monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ValueError, match=name):
        ProcessSettings.from_environment()
