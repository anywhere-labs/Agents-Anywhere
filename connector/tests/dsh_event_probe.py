"""Headless integration probe called by the plugin's real SDK fixture.

Uses the unchanged backend app through ASGI and a temporary SQLite database.
No dev server, user credentials, or actual model provider is used.
"""
# Import the app only after isolating its database URL and local module paths.
# ruff: noqa: E402
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / "server"), str(ROOT / "connector")]
# The test must never resolve an inherited development database URL.
os.environ.pop("AGENT_SERVER_DB_URL", None)

import httpx
from jsonschema import Draft202012Validator

from agent_server.app import create_app
from agent_server.core.auth import create_connector_access_token
from connector.runtimes.dsh.provider import DshProvider
from connector.runtimes.dsh.runtime import DshRuntime
from connector.server.ingest import ConnectorIngestClient
from connector.server.runtime_host import ConnectorRuntimeHost

SYNC_SCHEMA = Draft202012Validator(json.loads((ROOT / "contracts/dsh-bridge/1.0/schemas/sync-batch.schema.json").read_text()))


class CheckedRuntime(DshRuntime):
    async def _handle_notification(self, method, params):
        if method == "runtime.sync.batch":
            SYNC_SCHEMA.validate(params)
        await super()._handle_notification(method, params)


async def until(check, label: str) -> None:
    for _ in range(500):
        if await check():
            return
        await asyncio.sleep(0.02)
    raise AssertionError(label)


class IngestTransport(httpx.AsyncBaseTransport):
    def __init__(self, app) -> None:
        self.inner = httpx.ASGITransport(app)
        self.notifications: list[dict] = []
        self.lose_snapshot_reply = False
        self.lost = False

    async def handle_async_request(self, request):
        assert request.url.path == "/api/v2/connector/ingest"
        notices = json.loads(request.content)["notifications"]
        response = await self.inner.handle_async_request(request)
        await response.aread()
        assert response.status_code == 200, response.text
        assert not response.json().get("rejected"), response.text
        self.notifications.extend(notices)
        if self.lose_snapshot_reply and any(n["method"] == "timeline.sync" for n in notices):
            self.lose_snapshot_reply = False
            self.lost = True
            raise httpx.ReadError("Simulated lost HTTP reply after ingestion", request=request)
        return response


async def main(home: Path) -> None:
    app = create_app(home / "server-test.sqlite3")
    await app.state.store.create_user(user_id="dsh-test", password_hash="test-only")
    async with app.router.lifespan_context(app):
        store = app.state.store
        connector, _, _ = await store.create_connector(name="test", user_id="dsh-test")
        token = create_connector_access_token(connector.id)
        transport = IngestTransport(app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
            async def access_token(_force):
                return token

            ingest = ConnectorIngestClient("http://test", access_token, lambda: http, lambda _timeout: http)

            async def notify(method, params):
                await ingest.ingest_notifications([{"method": method, "params": params}])

            async def download(*_args):
                raise AssertionError("Text messaging must not download attachments")

            host = ConnectorRuntimeHost(connector.id, notify, download, ingest_notifications=ingest.ingest_notifications)
            config = await DshProvider().validate_config({"dshHome": str(home), "restartBackoffMs": 100})
            runtime = CheckedRuntime(config, host)

            def completed_inventories():
                return sum(n["method"] == "session.inventory.complete" for n in transport.notifications)

            async def ready():
                return completed_inventories() >= 1

            async def stored(session_id):
                await app.state.timeline_write_buffer.flush_through(session_id)
                return await store.timeline.read(session_id)

            async def finished(session_id, expected):
                state = await app.state.session_runtime_state_cache.get(session_id)
                items = await stored(session_id)
                return bool(state and state.status == "idle" and len([
                    i for i in items if i.type == "message" and i.role == "assistant" and i.status == "done"
                ]) == expected)

            async def native_action(action, session_id="native-main"):
                # The fixture performs official native UI-side mutations; this
                # is test-only IPC, never an AA -> DSH management capability.
                marker = home / "native-action.json"
                marker.write_text(json.dumps({"action": action, "sessionId": session_id}))
                async def acknowledged():
                    return not marker.exists()
                await until(acknowledged, f"native {action} was not handled")

            try:
                await runtime.start()
                await until(ready, "initial inventory failed")
                sessions = await store.list_sessions_for_connector(connector.id)
                assert {s.externalSessionId for s in sessions} == {"native-main", "persisted-only"}
                cold = next(s for s in sessions if s.externalSessionId == "persisted-only")
                assert len(await stored(cold.id)) == 1005, "all history pages must replace together"
                for session in sessions:
                    assert all(i.type not in {"turn.start", "turn.end"} for i in await stored(session.id))

                await native_action("draft", "native-draft")
                await asyncio.sleep(0.2)
                assert {s.externalSessionId for s in await store.list_sessions_for_connector(connector.id)} == {
                    "native-main", "persisted-only",
                }, "selecting a native draft must not create an AA session via snapshots or source notifications"
                await native_action("first-message", "native-draft")

                async def first_native_message():
                    matches = [s for s in await store.list_sessions_for_connector(connector.id)
                               if s.externalSessionId == "native-draft"]
                    if not matches:
                        return False
                    assert len(matches) == 1
                    items = await stored(matches[0].id)
                    return len([i for i in items if i.role == "user"
                                and i.content.get("text") == "first native user message"]) == 1

                await until(first_native_message, "first native user message did not create the AA session and timeline")

                result = await runtime.create_and_start_session("sess-new", "第一条", cwd=str(home), client_message_id="msg-1")
                external_id = result.result["externalSessionId"]
                await runtime.create_and_start_session("sess-new", "第一条", cwd=str(home), client_message_id="msg-1")
                await until(lambda: finished("sess-new", 1), "first text did not finish")
                await runtime.start_turn("sess-new", external_id, "第二条", client_message_id="msg-2")
                await until(lambda: finished("sess-new", 2), "second text did not finish")
                before = await stored("sess-new")
                assert len([i for i in before if i.role == "user"]) == 2, "retry duplicated user input"
                assert {i.source.clientMessageId for i in before if i.role == "user"} == {"msg-1", "msg-2"}
                assert any(n["method"] == "timeline.itemUpsert"
                           and n["params"]["item"]["status"] == "running"
                           and n["params"]["item"]["content"].get("text") == "你"
                           for n in transport.notifications), "missing partial-token updates"

                # Existing full replacement must remove a legacy notice, not append
                # a second copy of already synchronized user/assistant messages.
                stale = {"id": "legacy-notice", "sessionId": "sess-new", "type": "system", "status": "done",
                         "role": "system", "orderSeq": 200, "revision": 1, "contentHash": "legacy",
                         "content": {"kind": "notice", "text": "old internal record"}, "source": {"runtime": "dsh"}}
                await host.publish_runtime_notifications("dsh", [{"method": "timeline.itemUpsert",
                    "params": {"sessionId": "sess-new", "item": stale}}])
                assert any(i.id == "legacy-notice" for i in await stored("sess-new"))
                count = completed_inventories()
                transport.lose_snapshot_reply = True
                await runtime.resynchronize()

                async def recovered():
                    return transport.lost and completed_inventories() > count

                await until(recovered, "lost reply did not trigger complete recalibration")
                assert await first_native_message(), "reconnection duplicated or lost the native first message"
                assert "empty-native" not in {
                    s.externalSessionId for s in await store.list_sessions_for_connector(connector.id)
                }, "reconnection must not import an empty native session"
                after = await stored("sess-new")
                assert [(i.id, i.orderSeq, i.contentHash, i.content) for i in after] == [
                    (i.id, i.orderSeq, i.contentHash, i.content) for i in before
                ], "reconnection changed IDs, duplicated messages or retained stale rows"
                workspaces = await runtime._request("workspace.list")
                assert any(Path(w["path"]).resolve() == home.resolve() and external_id in w["sessionIds"] for w in workspaces["workspaces"])
                main = next(s for s in sessions if s.externalSessionId == "native-main")
                project_id = (await store.get_session(main.id)).projectId
                assert (await store.get_project(project_id, user_id="dsh-test")).name == Path(main.cwd).name
                await store.update_project(project_id, user_id="dsh-test", pinned=True, name="AA only")
                assert all(w["title"] != "AA only" for w in (await runtime._request("workspace.list"))["workspaces"])
                await native_action("rename")

                # An explicit native archive event uses the existing ingestion path.
                await native_action("archive")
                async def archived_event():
                    session = await store.get_session(main.id)
                    return session.sourceAvailability == "archived" and session.archived
                await until(archived_event, "native archive event did not archive AA")

                # Skip the event feed: entering details must still see an archive.
                await runtime._sync.close()
                runtime._sync = None
                await native_action("archive", cold.externalSessionId)
                state = await runtime.get_session_state(cold.id, cold.externalSessionId)
                assert state.status == "blocked"
                archived = await store.get_session(cold.id)
                assert archived.sourceAvailability == "archived" and archived.archived
                denied = await runtime.start_turn(cold.id, cold.externalSessionId, "must not send", client_message_id="archived")
                assert not denied.ok and denied.code == "session_archived"
                history = [(item.id, item.contentHash) for item in await stored(main.id)]
                await native_action("delete")
                count = completed_inventories()
                await runtime.resynchronize()
                async def calibrated():
                    return completed_inventories() > count
                await until(calibrated, "offline archive calibration did not complete")
                assert (await store.get_session(main.id)).sourceAvailability == "archived"
                project = await store.get_project(project_id, user_id="dsh-test")
                assert project.name == "AA only" and project.pinned
                assert not any(n["method"] == "workspace.inventory" for n in transport.notifications)
                assert (await store.get_session(main.id)).projectId == project_id
                assert [(item.id, item.contentHash) for item in await stored(main.id)] == history
                assert runtime.sync_mode == "events"
                print("DSH event pipeline passed")
            finally:
                await runtime.stop()


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1])))
