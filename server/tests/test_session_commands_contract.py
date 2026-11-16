"""Public command dispatch boundaries, backed by the shared PostgreSQL test database."""

from test_backend_mvp import FakeLocalRpc, create_connector_and_session, make_client


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


def test_offline_before_command_dispatch_is_known_rejection(tmp_path):
    client, url, headers, rpc = command_client(tmp_path)

    async def offline(_):
        return False

    rpc.is_online = offline
    response = client.post(url, headers=headers, json={"command": "compact"})

    assert response.status_code == 409
    assert rpc.command_calls == 0
