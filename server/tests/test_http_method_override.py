"""X-HTTP-Method-Override middleware behavior for restricted HTTP clients."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from agent_server.infra.http_method_override import HttpMethodOverrideMiddleware


def _client() -> TestClient:
    app = FastAPI()

    @app.post("/probe")
    async def post_probe(request: Request) -> dict[str, str]:
        return {"method": request.method}

    @app.patch("/probe")
    async def patch_probe(request: Request) -> dict[str, str]:
        return {"method": request.method}

    @app.put("/probe")
    async def put_probe(request: Request) -> dict[str, str]:
        return {"method": request.method}

    app.add_middleware(HttpMethodOverrideMiddleware)
    return TestClient(app)


def test_post_is_rewritten_to_patch() -> None:
    response = _client().post(
        "/probe", headers={"X-HTTP-Method-Override": "PATCH"}, json={"a": 1}
    )
    assert response.status_code == 200
    assert response.json()["method"] == "PATCH"


def test_post_is_rewritten_to_put() -> None:
    response = _client().post(
        "/probe", headers={"X-HTTP-Method-Override": "put"}, json={"a": 1}
    )
    assert response.status_code == 200
    assert response.json()["method"] == "PUT"


def test_post_without_override_header_is_unchanged() -> None:
    response = _client().post("/probe", json={"a": 1})
    assert response.status_code == 200
    assert response.json()["method"] == "POST"


def test_override_to_disallowed_method_is_ignored() -> None:
    response = _client().post(
        "/probe", headers={"X-HTTP-Method-Override": "GET"}, json={"a": 1}
    )
    assert response.status_code == 200
    assert response.json()["method"] == "POST"


def test_non_post_requests_are_not_rewritten() -> None:
    response = _client().patch(
        "/probe", headers={"X-HTTP-Method-Override": "DELETE"}
    )
    assert response.status_code == 200
    assert response.json()["method"] == "PATCH"
