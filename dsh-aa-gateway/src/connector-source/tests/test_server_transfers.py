from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any, ClassVar, Self

import httpx
import pytest

from connector.server import transfers
from connector.server.errors import ConnectorNetworkError


class FakeResponse:
    def __init__(
        self,
        status_code: int,
        content: bytes = b"",
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status_code = status_code
        self.content = content
        self.headers = headers or {}

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeDownloadClient:
    calls: ClassVar[list[tuple[str, dict[str, str]]]] = []

    def __init__(self, _timeout: Any) -> None:
        return None

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def get(self, url: str, headers: dict[str, str]) -> FakeResponse:
        self.calls.append((url, headers))
        if len(self.calls) == 1:
            return FakeResponse(401)
        return FakeResponse(
            200,
            content=b"hello",
            headers={"X-File-Name": "hello.txt", "Content-Type": "text/plain"},
        )


class FakeUploadClient:
    calls: ClassVar[list[tuple[str, dict[str, str], dict[str, str], bytes]]] = []

    def __init__(self, _timeout: Any) -> None:
        return None

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def put(
        self,
        url: str,
        params: dict[str, str],
        headers: dict[str, str],
        content: AsyncIterator[bytes],
    ) -> FakeResponse:
        uploaded = b""
        async for chunk in content:
            uploaded += chunk
        self.calls.append((url, params, headers, uploaded))
        return FakeResponse(204)


class FailingDownloadClient:
    def __init__(self, _timeout: Any) -> None:
        return None

    async def __aenter__(self) -> Self:
        return self

    async def __aexit__(self, *args: object) -> None:
        return None

    async def get(self, url: str, headers: dict[str, str]) -> FakeResponse:
        _ = headers
        request = httpx.Request("GET", url)
        raise httpx.ConnectError("connection refused", request=request)


def test_download_attachment_refreshes_token_after_unauthorized() -> None:
    async def exercise() -> tuple[bytes, str, str]:
        tokens: list[bool] = []
        FakeDownloadClient.calls = []

        async def token_provider(force: bool = False) -> str:
            tokens.append(force)
            return "new" if force else "old"

        result = await transfers.download_attachment(
            server_url="http://127.0.0.1:8000",
            session_id="sess_1",
            file_id="file_1",
            access_token_provider=token_provider,
            http_client_factory=FakeDownloadClient,
        )
        assert tokens == [False, True]
        assert [call[1]["Authorization"] for call in FakeDownloadClient.calls] == [
            "Bearer old",
            "Bearer new",
        ]
        return result

    assert asyncio.run(exercise()) == (b"hello", "hello.txt", "text/plain")


def test_download_attachment_network_error_is_explicit() -> None:
    async def exercise() -> None:
        async def token_provider(force: bool = False) -> str:
            _ = force
            return "token"

        with pytest.raises(ConnectorNetworkError, match="attachment download failed"):
            await transfers.download_attachment(
                server_url="http://127.0.0.1:8000",
                session_id="sess_1",
                file_id="file_1",
                access_token_provider=token_provider,
                http_client_factory=FailingDownloadClient,
            )

    asyncio.run(exercise())


def test_upload_prepared_download_streams_file_content(tmp_path) -> None:
    async def exercise() -> dict[str, Any]:
        path = tmp_path / "artifact.txt"
        path.write_bytes(b"artifact")
        FakeUploadClient.calls = []

        async def token_provider(force: bool = False) -> str:
            assert force is False
            return "token"

        return await transfers.upload_prepared_download(
            server_url="http://127.0.0.1:8000",
            prepared_path=str(path),
            params={
                "transferId": "tx_1",
                "token": "upload_token",
                "uploadUrl": "/connector/uploads/tx_1",
            },
            access_token_provider=token_provider,
            http_client_factory=FakeUploadClient,
        )

    result = asyncio.run(exercise())

    assert result == {"transferId": "tx_1", "uploaded": True}
    assert FakeUploadClient.calls == [
        (
            "http://127.0.0.1:8000/api/v2/connector/uploads/tx_1",
            {"token": "upload_token"},
            {"Authorization": "Bearer token"},
            b"artifact",
        )
    ]
