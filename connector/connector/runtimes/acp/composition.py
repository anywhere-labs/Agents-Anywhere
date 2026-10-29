from __future__ import annotations

import hashlib

from .application.sessions import SessionService
from .application.synchronization import SynchronizationService
from .infrastructure.acp.client import AgentClient
from .infrastructure.persistence import Store
from .infrastructure.projection import Projection


def build_services(config, host, profile, launch, *, preparation_driver=None, client_factory=AgentClient):
    namespace = hashlib.sha256(
        f"{host.session_namespace}:{config.runtime_id}".encode()
    ).hexdigest()
    root = host.runtime_kv.path.parent / "acp" / namespace
    store = Store(root / "coordination.sqlite")
    app = SessionService(
        store,
        profile,
        launch,
        client_factory,
        Projection,
        root,
        max_workers=config.values.get("maxWorkers", 8),
        max_runs=config.values.get("maxConcurrentRuns", 4),
        max_run_seconds=config.values.get("maxRunMs", 600000) / 1000,
        preparation_driver=preparation_driver,
        runtime_type=config.runtime,
    )

    async def publish(notifications):
        await host.publish_runtime_notifications(
            config.runtime,
            [
                {**item, "params": {**item["params"], "runtimeId": config.runtime_id}}
                for item in notifications
            ],
            runtime_id=config.runtime_id,
        )

    sync = SynchronizationService(store, publish)
    return app, sync
