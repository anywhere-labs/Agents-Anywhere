"""Public command dispatch boundaries, backed by the shared PostgreSQL test database."""

import pytest
from test_backend_mvp import FakeLocalRpc, create_connector_and_session, make_client

from agent_server.infra.connector_rpc import ConnectorOfflineError, ConnectorRpcError

_DEFAULT_OUTCOME = object()


def command_client(tmp_path, outcome=_DEFAULT_OUTCOME):
    client = make_client(tmp_path)
    _, _, session_id, headers = create_connector_and_session(client)

    class Rpc(FakeLocalRpc):
        command_calls = 0

        async def request(self, connector_id, method, params, *, timeout=30):
            if method == "session.command.execute":
                self.command_calls += 1
                if isinstance(outcome, Exception):
                    raise outcome
                if outcome is not _DEFAULT_OUTCOME:
                    return outcome
            return await super().request(connector_id, method, params, timeout=timeout)

    rpc = Rpc()
    client.app.state.rpc = rpc
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()
    return client, f"/sessions/{session_id}/runtime/commands", headers, rpc


@pytest.mark.parametrize("raw", ["", " \t ", "/goal create first\n second  "])
def test_command_preserves_exact_raw_including_empty(tmp_path, raw):
    client, url, headers, rpc = command_client(tmp_path)
    response = client.post(
        url,
        headers=headers,
        json={"command": "goal", "raw": raw, "args": ["different input"]},
    )

    assert response.status_code == 200, response.text
    assert rpc.requests[-1][2]["raw"] == raw
    assert rpc.command_calls == 1


@pytest.mark.parametrize("args", [[], [""], ["create  first\n second  "]])
def test_command_preserves_free_form_args_without_raw(tmp_path, args):
    client, url, headers, rpc = command_client(tmp_path)
    response = client.post(
        url, headers=headers, json={"command": "goal", "args": args}
    )

    assert response.status_code == 200, response.text
    assert rpc.requests[-1][2]["args"] == args
    assert "raw" not in rpc.requests[-1][2]


@pytest.mark.parametrize("args", [None, "text", [1], [True], [None], [{}], [[]]])
def test_malformed_args_are_rejected_before_command_dispatch(tmp_path, args):
    client, url, headers, rpc = command_client(tmp_path)
    response = client.post(
        url, headers=headers, json={"command": "goal", "args": args}
    )

    assert response.status_code == 422
    assert rpc.command_calls == 0


@pytest.mark.parametrize(
    "query, limit",
    [(" Goal ", 999), ("", 1), ("x" * 4096, 1000)],
    ids=["whitespace", "empty", "upper-bound"],
)
def test_catalog_forwards_valid_query_and_limit(tmp_path, query, limit):
    client, url, headers, rpc = command_client(tmp_path)
    response = client.get(url, headers=headers, params={"query": query, "limit": limit})

    assert response.status_code == 200, response.text
    assert rpc.requests[-1][2]["query"] == query
    assert rpc.requests[-1][2]["limit"] == limit


@pytest.mark.parametrize("limit", [0, -1, 1001, "1.5", "true"])
def test_catalog_rejects_invalid_limit_before_dispatch(tmp_path, limit):
    client, url, headers, rpc = command_client(tmp_path)
    response = client.get(url, headers=headers, params={"limit": limit})

    assert response.status_code == 422
    assert not any(method == "session.commands" for _, method, _, _ in rpc.requests)


def test_catalog_rejects_oversize_query_before_dispatch(tmp_path):
    client, url, headers, rpc = command_client(tmp_path)
    response = client.get(url, headers=headers, params={"query": "x" * 4097})

    assert response.status_code == 422
    assert not any(method == "session.commands" for _, method, _, _ in rpc.requests)


@pytest.mark.parametrize(
    "outcome",
    [
        TimeoutError("secret"),
        ConnectorOfflineError("secret"),
        None,
        [],
        {},
        {"command": "compact", "ok": "true", "result": {}},
        {"command": "compact", "ok": 1, "result": {}},
        {"command": "other", "ok": True, "result": {}},
        {"command": "compact", "ok": True},
        {"command": "compact", "ok": True, "result": []},
        {"command": "compact", "ok": True, "result": {}, "code": 1},
        {"command": "compact", "ok": True, "result": {}, "message": []},
    ],
)
def test_ambiguous_dispatch_is_not_retried_or_reported_as_success(tmp_path, outcome):
    client, url, headers, rpc = command_client(tmp_path, outcome)
    response = client.post(url, headers=headers, json={"command": "compact"})

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["command"] == "compact"
    assert data["ok"] is False
    assert data["code"] == "command_outcome_unknown"
    assert data["result"] == {"executionState": "unknown", "retryable": False}
    assert "secret" not in response.text
    assert rpc.command_calls == 1


def test_known_native_error_and_correlation_are_preserved(tmp_path):
    outcome = {
        "command": "compact",
        "ok": False,
        "code": "command_error",
        "message": "busy",
        "result": {
            "executionState": "completed",
            "commandId": "native-command-1",
            "kind": "error",
            "text": " busy\n",
            "sourceEventSeq": 17,
        },
    }
    client, url, headers, rpc = command_client(tmp_path, outcome)
    response = client.post(url, headers=headers, json={"command": "compact"})

    assert response.status_code == 200, response.text
    data = response.json()
    assert {key: data[key] for key in outcome} == outcome
    assert rpc.command_calls == 1


@pytest.mark.parametrize(
    "ok, result",
    [
        (True, {"executionState": "accepted"}),
        (True, {"executionState": "completed"}),
        (False, {"executionState": "unknown", "retryable": False}),
    ],
)
def test_known_execution_state_is_preserved(tmp_path, ok, result):
    client, url, headers, rpc = command_client(
        tmp_path, {"command": "compact", "ok": ok, "result": result}
    )
    response = client.post(url, headers=headers, json={"command": "compact"})

    assert response.status_code == 200, response.text
    assert response.json()["ok"] is ok
    assert response.json()["result"] == result
    assert rpc.command_calls == 1


@pytest.mark.parametrize(
    "ok, result",
    [
        (True, {"executionState": "pending"}),
        (True, {"executionState": "unknown", "retryable": False}),
        (True, {"executionState": "accepted", "retryable": "false"}),
        (False, {"executionState": "unknown"}),
        (False, {"executionState": "unknown", "retryable": True}),
    ],
)
def test_invalid_execution_state_is_reported_as_unknown(tmp_path, ok, result):
    client, url, headers, rpc = command_client(
        tmp_path, {"command": "compact", "ok": ok, "result": result}
    )
    response = client.post(url, headers=headers, json={"command": "compact"})

    assert response.status_code == 200, response.text
    assert response.json()["ok"] is False
    assert response.json()["code"] == "command_outcome_unknown"
    assert response.json()["result"] == {"executionState": "unknown", "retryable": False}
    assert rpc.command_calls == 1


@pytest.mark.parametrize(
    "ok, result",
    [
        (True, {"executionState": "accepted"}),
        (True, {"executionState": "completed"}),
        (False, {"executionState": "accepted", "retryable": False}),
        (False, {}),
        (False, {"retryable": True}),
    ],
)
def test_unknown_outcome_code_cannot_report_success_or_allow_retry(tmp_path, ok, result):
    client, url, headers, rpc = command_client(
        tmp_path,
        {
            "command": "compact",
            "ok": ok,
            "code": "command_outcome_unknown",
            "result": result,
        },
    )
    response = client.post(url, headers=headers, json={"command": "compact"})

    assert response.status_code == 200, response.text
    assert response.json()["ok"] is False
    assert response.json()["code"] == "command_outcome_unknown"
    assert response.json()["result"] == {"executionState": "unknown", "retryable": False}
    assert rpc.command_calls == 1


def test_explicit_rpc_error_is_not_retried(tmp_path):
    client, url, headers, rpc = command_client(
        tmp_path, ConnectorRpcError("unsupported_command", "Command is unavailable.")
    )
    response = client.post(url, headers=headers, json={"command": "compact"})

    assert response.status_code == 502
    assert response.json()["detail"] == {
        "code": "unsupported_command",
        "message": "Command is unavailable.",
    }
    assert rpc.command_calls == 1


def test_offline_before_command_dispatch_is_known_rejection(tmp_path):
    client, url, headers, rpc = command_client(tmp_path)

    async def offline(_):
        return False

    rpc.is_online = offline
    response = client.post(url, headers=headers, json={"command": "compact"})

    assert response.status_code == 409
    assert rpc.command_calls == 0
