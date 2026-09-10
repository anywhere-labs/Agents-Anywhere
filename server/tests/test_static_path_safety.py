"""Exercise static routes without a listening server or external database."""

import pytest
from fastapi.testclient import TestClient

from agent_server.app import create_app


@pytest.fixture
def static_client(tmp_path, monkeypatch):
    root = tmp_path / "public"
    (root / "en").mkdir(parents=True)
    (root / "en" / "index.html").write_text("home")
    (root / "page.html").write_text("page")
    secret = tmp_path / "secret.txt"
    secret.write_text("private-value")
    (root / "leak.txt").symlink_to(secret)
    (root / "leak.html").symlink_to(secret)
    (root / "directory").mkdir()
    (root / "directory" / "index.html").symlink_to(secret)
    (root / "en" / "localized").mkdir()
    (root / "en" / "localized" / "index.html").symlink_to(secret)
    monkeypatch.setenv("AGENT_SERVER_STATIC_DIR", str(root))
    return TestClient(create_app(tmp_path / "test.sqlite3"))


@pytest.mark.parametrize("path", [
    "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/%2e%2e%5csecret.txt",
    "/leak.txt", "/leak", "/directory", "/localized",
])
@pytest.mark.parametrize("method", ["GET", "HEAD"])
def test_static_routes_reject_escape(static_client, path, method):
    response = static_client.request(method, path)
    assert response.status_code == 404
    assert "private-value" not in response.text


def test_static_routes_keep_export_fallbacks(static_client):
    assert static_client.get("/").text == "home"
    assert static_client.get("/page").text == "page"
    assert static_client.get("/page.html").text == "page"
    assert static_client.get("/unknown").text == "home"
