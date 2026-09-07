"""Invoked by the TypeScript native Host integration test; never touches the real DSH_HOME."""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator

from connector.runtime_protocol import RuntimeUnsupportedError, timeline_content_hash
from connector.runtimes.dsh.discovery import discover
from connector.runtimes.dsh.provider import DshProvider
from connector.runtimes.dsh.runtime import DshRuntime
from connector.runtimes.session_identity import stable_runtime_session_id
from connector.server.runtime_sync import session_requires_timeline_sync


class Host:
    connector_id = "connector-native-test"
    session_namespace = "connector-native-test:instance-1"

    def __init__(self) -> None:
        self.capabilities = []

    async def runtime_capabilities_update(self, capabilities) -> None:
        self.capabilities.append(capabilities)

    async def runtime_error(self, *args, **kwargs) -> None:
        pass

    async def publish_runtime_notifications(self, runtime, notifications, **kwargs):
        pass

    async def sync_state_write(self, key, value):
        pass


async def main(home: Path) -> None:
    values = {"dshHome": str(home)}
    assert (await discover(values)).available
    provider = DshProvider()
    config = await provider.validate_config(values)
    host = Host()
    runtime = DshRuntime(config, host)
    try:
        await runtime.start()
        assert host.capabilities
        assert not any(
            c.supported
            for c in host.capabilities[0].capabilities
            if c.capability_id != "runtime.config"
        )
        inventory = await runtime.list_complete_session_inventory(page_size=1)
        assert {m.external_session_id for m in inventory} == {
            "native-main",
            "persisted-only",
        }
        assert all(session_requires_timeline_sync(m) for m in inventory)
        main_meta = next(m for m in inventory if m.external_session_id == "native-main")
        assert main_meta.title == "官方原生会话"
        assert main_meta.session_id == stable_runtime_session_id(
            host.session_namespace, "dsh", "native-main"
        )
        schema = json.loads(
            (
                Path(__file__).resolve().parents[2]
                / "contracts/dsh-bridge/1.0/schemas/timeline-item.schema.json"
            ).read_text()
        )
        for meta in inventory:
            snapshot = await runtime.get_session_snapshot(
                meta.session_id, meta.external_session_id
            )
            assert snapshot.complete
            if meta.external_session_id == "persisted-only":
                assert (
                    len(snapshot.items) == 1007
                )  # Requires multiple frames; no lost page.
            for item in snapshot.items:
                assert item.content_hash == timeline_content_hash(
                    item.type, item.status, item.role, item.content
                )
                Draft202012Validator(schema).validate(
                    {
                        "id": item.id,
                        "sessionId": item.session_id,
                        "type": item.type,
                        "status": item.status,
                        "orderSeq": item.order_seq,
                        "revision": item.revision,
                        "role": item.role,
                        "contentHash": item.content_hash,
                        "content": item.content,
                        "source": item.source,
                    }
                )
            limited = await runtime.get_session_snapshot(
                meta.session_id, meta.external_session_id, limit=1
            )
            if meta.external_session_id == "empty-native":
                assert limited.complete and len(limited.items) == 0
            else:
                assert not limited.complete and len(limited.items) == 1
            state = await runtime.get_session_state(
                meta.session_id, meta.external_session_id
            )
            assert state.status == "idle"
        try:
            await runtime.list_model_catalog()
            raise AssertionError("Read-only runtime exposed a model catalog")
        except RuntimeUnsupportedError:
            pass
        # A real discovery probe can run alongside an established runtime connection.
        assert (await discover(values)).available
        assert len(await runtime.list_sessions()) == 2
    finally:
        await runtime.stop()
    print("DSH native integration passed")


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1])))
