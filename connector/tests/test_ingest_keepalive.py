"""A pooled connection the backend closed underneath a request: it is reopened once, and only then.

uvicorn closes an idle keep-alive connection after 5 s. A request written just as the server
closes it fails with RemoteProtocolError before any response, which used to fail the batch.
The pool expires idle connections first (test_connector_network.py); these tests cover the
remaining race and the contract the sender keeps for every other failure."""
from __future__ import annotations

import asyncio

import httpx
import pytest

from connector.server.auth import ConnectorAuthenticationError
from connector.server.errors import ConnectorNetworkError
from connector.server.ingest import TRANSPORT_REOPEN_ATTEMPTS, ConnectorIngestClient

URL = "https://server.test/api/v2/connector/ingest"


def _closed() -> httpx.RemoteProtocolError:
    # What a pooled connection looks like when the backend closed it under a request.
    return httpx.RemoteProtocolError("Server disconnected without sending a response.")


def _response(status: int) -> httpx.Response:
    return httpx.Response(status, json={"accepted": 0, "rejected": []}, request=httpx.Request("POST", URL))


class _Scripted:
    """A send() that plays back outcomes: an exception to raise, or a response."""

    def __init__(self, *outcomes: object) -> None:
        self.outcomes = list(outcomes)
        self.calls = 0

    async def __call__(self, token: str) -> httpx.Response:
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


def _client(token=None) -> ConnectorIngestClient:
    return ConnectorIngestClient("https://server.test", token, lambda: None, lambda timeout: httpx.AsyncClient(timeout=timeout))


async def _send(client: ConnectorIngestClient, send) -> httpx.Response:
    return await client._send_with_auth(send, "token", size=0)


def test_a_connection_the_backend_closed_is_reopened_once_and_the_batch_delivered():
    async def run():
        send = _Scripted(_closed(), _response(200))
        response = await _send(_client(), send)
        assert response.status_code == 200 and send.calls == 2

    asyncio.run(run())


def test_a_second_closed_connection_is_surfaced_after_exactly_one_reopen():
    async def run():
        send = _Scripted(_closed(), _closed(), _response(200))
        with pytest.raises(ConnectorNetworkError):
            await _send(_client(), send)
        assert send.calls == 1 + TRANSPORT_REOPEN_ATTEMPTS == 2

    asyncio.run(run())


@pytest.mark.parametrize("failure", [
    httpx.ConnectError("refused"), httpx.ReadTimeout("slow"), httpx.WriteError("broken pipe"),
])
def test_other_transport_failures_are_not_retried_inside_the_sender(failure):
    # An unreachable backend is covered by the retry loop above, within its own budget.
    async def run():
        send = _Scripted(failure, _response(200))
        with pytest.raises(ConnectorNetworkError):
            await _send(_client(), send)
        assert send.calls == 1

    asyncio.run(run())


def test_http_errors_are_never_retried_inside_the_sender():
    async def run():
        refused = _Scripted(_response(422), _response(200))
        with pytest.raises(httpx.HTTPStatusError):
            await _send(_client(), refused)
        assert refused.calls == 1

        unavailable = _Scripted(_response(503), _response(200))
        with pytest.raises(ConnectorNetworkError):
            await _send(_client(), unavailable)
        assert unavailable.calls == 1

    asyncio.run(run())


def test_a_refreshed_token_goes_through_the_same_reopen():
    async def run():
        refreshed: list[bool] = []

        async def token(force: bool) -> str:
            refreshed.append(force)
            return "token-2" if force else "token-1"

        send = _Scripted(_response(401), _closed(), _response(200))
        response = await _send(_client(token), send)
        assert response.status_code == 200 and send.calls == 3 and refreshed == [True]

        twice = _Scripted(_response(401), _response(401))
        with pytest.raises(ConnectorAuthenticationError):
            await _send(_client(token), twice)
        assert twice.calls == 2

    asyncio.run(run())
