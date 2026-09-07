"""Real DSH question bridge -> existing authenticated backend routes, without a dev server."""
# ruff: noqa: E402
from __future__ import annotations

from connector.runtimes.dsh.identity import model_selection_id, permission_selection_id

import asyncio
import sys
from pathlib import Path

from dsh_event_probe import CheckedRuntime, IngestTransport, until
import httpx
from jsonschema import Draft202012Validator

from agent_server.app import create_app
from agent_server.core.auth import create_connector_access_token, create_user_access_token
from connector.runtimes.dsh.provider import DshProvider
from connector.server.ingest import ConnectorIngestClient
from connector.server.runtime_host import ConnectorRuntimeHost
from connector.server.runtime_rpc_payloads import session_state_payload
from connector.server.runtime_session_rpc import read_session_capabilities, read_session_notices
from connector.server.runtime_turn_rpc import dispatch_interaction_respond


async def main(home: Path) -> None:
    app = create_app(home / "questions-test.sqlite3")
    await app.state.store.create_user(user_id="question-test", password_hash="test-only")
    async with app.router.lifespan_context(app):
        connector, _, _ = await app.state.store.create_connector(name="question-test", user_id="question-test")
        transport = IngestTransport(app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ingest_http, httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test/api/v2",
            headers={"Authorization": f"Bearer {create_user_access_token('question-test')}"},
        ) as web:
            async def token(_force):
                return create_connector_access_token(connector.id)

            ingest = ConnectorIngestClient("http://test", token, lambda: ingest_http, lambda _timeout: ingest_http)

            async def notify(method, params):
                await ingest.ingest_notifications([{"method": method, "params": params}])

            async def download(*_args):
                raise AssertionError("Questions must not download files")

            host = ConnectorRuntimeHost(connector.id, notify, download, ingest_notifications=ingest.ingest_notifications)
            runtime = CheckedRuntime(await DshProvider().validate_config({"dshHome": str(home)}), host)
            original_rpc = app.state.rpc

            class Rpc:
                def __getattr__(self, name):
                    return getattr(original_rpc, name)

                async def is_online(self, connector_id):
                    return connector_id == connector.id

                async def request(self, connector_id, method, params, timeout=30):
                    assert connector_id == connector.id
                    if method == "session.notices":
                        return await read_session_notices(runtime, params)
                    if method == "session.capabilities":
                        return await read_session_capabilities(runtime, params)
                    if method == "session.state":
                        return {"state": session_state_payload(await runtime.get_session_state(params["sessionId"], params.get("externalSessionId")))}
                    if method == "interaction.respond":
                        return await dispatch_interaction_respond(runtime, params)
                    raise AssertionError(method)

            # Only the server-to-Connector network carrier is in-process. The runtime
            # still crosses the real authenticated TCP bridge into the published Host.
            app.state.rpc = Rpc()
            try:
                await runtime.start()

                async def inventory_ready():
                    return any(n["method"] == "session.inventory.complete" for n in transport.notifications)

                await until(inventory_ready, "initial sync")
                await runtime.create_and_start_session("ask-session", "先问我问题", cwd=str(home), selections={"model": model_selection_id("test", "text", None), "permission": permission_selection_id("workspace-write")}, runtime_options={"agentPreset": "standard"}, client_message_id="ask-1")

                async def question_ready():
                    return any(n["method"] == "notice.upsert" and n["params"].get("sessionId") == "ask-session"
                               and n["params"].get("status") == "open" for n in transport.notifications)

                await until(question_ready, "input request was not ingested")
                response = await web.get("sessions/ask-session/runtime/notices")
                response.raise_for_status()
                notice = next(n for n in response.json()["notices"] if n["status"] == "open")
                assert notice["interactionType"] == "input_request"
                schema = notice["actions"][0]["input"]
                assert schema["uiSchema"]["component"] == "inputRequest" and schema["uiSchema"]["version"] == 1
                assert (await runtime.get_session_state("ask-session")).status == "waiting_approval"

                # Stop/reconnect the actual Python bridge while DSH is waiting.
                notice_id = notice["noticeId"]
                await runtime.stop()
                await runtime.start()
                restored = await runtime.get_session_notices("ask-session")
                assert [n.notice_id for n in restored if n.status == "open"] == [notice_id]

                path = f"sessions/ask-session/runtime/notices/{notice_id}/respond"
                answer = {"answers": {"mode": {"optionIds": ["o_1"]}, "targets": {"optionIds": ["o_0", "o_1"], "customText": "iOS"}, "notes": {"customText": "简洁"}}}
                Draft202012Validator(schema["schema"]).validate(answer)
                denied = await web.post(path, json={"actionId": "submit", "input": answer})
                assert denied.status_code == 409, "existing takeover requirement must remain enforced"
                takeover = await web.post("sessions/ask-session/takeover")
                takeover.raise_for_status()
                response = await web.post(path, json={"actionId": "submit", "input": answer})
                response.raise_for_status()
                assert response.json()["result"]["resolved"] is True, response.text

                async def finished():
                    await app.state.timeline_write_buffer.flush_through("ask-session")
                    timeline = await app.state.store.timeline.read("ask-session")
                    return any(i.role == "assistant" and i.status == "done" and i.content.get("text") == "收到回答，继续执行。" for i in timeline)

                await until(finished, "agent did not resume after the existing backend response endpoint")
                resolved = await web.get("sessions/ask-session/runtime/notices")
                resolved.raise_for_status()
                assert all(n["status"] not in {"open", "responding"} for n in resolved.json()["notices"])
                print("DSH question pipeline passed")
            finally:
                await runtime.stop()
                app.state.rpc = original_rpc


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1])))
