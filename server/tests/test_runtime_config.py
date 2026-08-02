from __future__ import annotations

import asyncio
import json
from copy import deepcopy
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import delete, select, update

from agent_server.app import create_app
from agent_server.core.runtime_config import (
    DEFAULT_RUNTIME_CONFIG_SCHEMAS,
    is_rollback_safe_codex_schema,
    runtime_schema_key,
    validate_runtime_schema,
)
from agent_server.infra.db import (
    agent_efforts as agent_efforts_t,
    agent_models as agent_models_t,
    device_agent_settings as device_agent_settings_t,
    instance_settings as instance_settings_t,
    sessions as sessions_t,
    user_agent_defaults as user_agent_defaults_t,
)


def make_client(tmp_path):
    return TestClient(create_app(tmp_path / "test.sqlite3"))


ADMIN_USER = "user1"
ADMIN_PASSWORD = "secret"


def auth_headers(
    client: TestClient,
    user_id: str = ADMIN_USER,
    password: str = ADMIN_PASSWORD,
) -> dict[str, str]:
    login = client.post("/auth/login", json={"userId": user_id, "password": password})
    if login.status_code == 200:
        return {"Authorization": f"Bearer {login.json()['accessToken']}"}
    cfg = client.get("/auth/config").json()
    body: dict[str, Any] = {"userId": user_id, "password": password}
    if cfg["needsBootstrap"]:
        body["setupToken"] = client.app.state.setup_token.peek()
    register = client.post("/auth/register", json=body)
    assert register.status_code == 200, register.text
    return {"Authorization": f"Bearer {register.json()['accessToken']}"}


def create_connector_and_session(client: TestClient):
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert connector_response.status_code == 200, connector_response.text
    connector_body = connector_response.json()
    connector_id = connector_body["connector"]["id"]
    connector_token = connector_body["connectorToken"]
    auth_response = client.post(
        "/connector/auth",
        headers={"Authorization": f"Connector {connector_id}:{connector_token}"},
    )
    assert auth_response.status_code == 200, auth_response.text
    access_token = auth_response.json()["accessToken"]
    session_response = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "externalSessionId": f"thr_{connector_id}_demo",
            "title": "Demo",
            "cwd": "/repo",
        },
    )
    assert session_response.status_code == 200, session_response.text
    session_id = session_response.json()["session"]["id"]
    return connector_id, access_token, session_id, headers


class FakeRpc:
    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, Any]]] = []

    def is_online(self, connector_id: str) -> bool:
        return True

    async def request(self, connector_id: str, method: str, params: dict[str, Any], **_: Any) -> dict[str, Any]:
        self.requests.append((connector_id, method, params))
        return {"ok": True}


def legacy_codex_models() -> list[dict[str, Any]]:
    efforts = [
        {"key": "low", "displayLabel": "Low", "sortOrder": 1},
        {"key": "medium", "displayLabel": "Medium", "sortOrder": 2},
        {"key": "high", "displayLabel": "High", "sortOrder": 3},
        {"key": "xhigh", "displayLabel": "Extra high", "sortOrder": 4},
    ]
    return [
        {
            "key": key,
            "displayLabel": label,
            "sortOrder": index,
            "efforts": deepcopy(efforts),
        }
        for index, (key, label) in enumerate(
            (
                ("gpt-5.5", "GPT-5.5"),
                ("gpt-5.4", "GPT-5.4"),
                ("gpt-5.4-mini", "GPT-5.4 Mini"),
                ("gpt-5.3-codex", "GPT-5.3 Codex"),
                ("gpt-5.2", "GPT-5.2"),
            ),
            start=1,
        )
    ]


def test_runtime_config_schema_is_seeded_and_readable(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    response = client.get("/agents/claude/config-schema", headers=headers)

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["runtime"] == "claude"
    assert body["schema"]["runtime"] == "claude"
    fields = {field["key"]: field for field in body["schema"]["fields"]}
    assert "runMode" not in fields
    assert fields["permissionMode"]["allowSessionOverride"] is True


def test_codex_v4_schema_is_virtual_over_rollback_safe_durable_schema(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    key = runtime_schema_key("codex")

    async def raw_schema() -> str:
        async with client.app.state.store.engine.connect() as conn:
            return (
                await conn.execute(
                    select(instance_settings_t.c.value).where(instance_settings_t.c.key == key)
                )
            ).scalar_one()

    durable_before = asyncio.run(raw_schema())
    durable = json.loads(durable_before)
    assert durable["schemaVersion"] == 3
    assert "gpt-5.6" not in durable_before
    assert '"max"' not in durable_before
    assert '"ultra"' not in durable_before
    assert "isDefault" not in durable_before

    response = client.get("/agents/codex/config-schema", headers=headers)
    assert response.status_code == 200, response.text
    projected = response.json()["schema"]
    assert projected["schemaVersion"] == 4
    model_field = next(field for field in projected["fields"] if field["key"] == "model")
    assert model_field["options"][0]["value"] == "gpt-5.6-sol"

    # A read must not materialize v4/GPT-5.6 into the database.
    assert asyncio.run(raw_schema()) == durable_before


def test_runtime_schema_converges_exact_v4_and_heals_empty_but_preserves_custom(tmp_path):
    client = make_client(tmp_path)
    store = client.app.state.store
    key = runtime_schema_key("codex")

    async def read_raw() -> str:
        async with store.engine.connect() as conn:
            return (
                await conn.execute(
                    select(instance_settings_t.c.value).where(instance_settings_t.c.key == key)
                )
            ).scalar_one()

    async def exercise() -> tuple[str, str, str, str]:
        current = DEFAULT_RUNTIME_CONFIG_SCHEMAS["codex"].model_dump(exclude_none=True)
        await store.set_runtime_config_schema("codex", current)
        await store.seed_runtime_config_schemas()
        converged = await read_raw()

        # Empty same-version payloads are interrupted built-in seed shapes,
        # and are safe to repair. A non-empty edited schema is operator data.
        await store.instance_settings.set(
            key,
            json.dumps({"runtime": "codex", "schemaVersion": 4, "fields": []}),
        )
        await store.seed_runtime_config_schemas()
        healed = await read_raw()

        custom = deepcopy(current)
        next(field for field in custom["fields"] if field["key"] == "model")["label"] = "Private model"
        await store.set_runtime_config_schema("codex", custom)
        before_custom_reseed = await read_raw()
        await store.seed_runtime_config_schemas()
        after_custom_reseed = await read_raw()

        custom_constraints = deepcopy(current)
        model_options = next(
            field for field in custom_constraints["fields"] if field["key"] == "model"
        )["options"]
        model_options[0]["isDefault"] = False
        model_options[1]["isDefault"] = True
        model_options[0]["efforts"] = []
        await store.set_runtime_config_schema("codex", custom_constraints)
        before_constraint_reseed = await read_raw()
        await store.seed_runtime_config_schemas()
        after_constraint_reseed = await read_raw()
        return (
            converged,
            healed,
            before_custom_reseed,
            after_custom_reseed,
            before_constraint_reseed,
            after_constraint_reseed,
        )

    converged, healed, custom_before, custom_after, constraints_before, constraints_after = asyncio.run(exercise())
    assert is_rollback_safe_codex_schema(
        validate_runtime_schema("codex", json.loads(converged))
    )
    assert is_rollback_safe_codex_schema(
        validate_runtime_schema("codex", json.loads(healed))
    )
    assert "isDefault" not in converged
    assert "isDefault" not in healed
    assert custom_after == custom_before
    assert constraints_after == constraints_before


def test_user_defaults_empty_patch_preserves_raw_snapshot_and_explicit_empty_is_global(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    initial = client.patch(
        "/agents/defaults",
        headers=headers,
        json={
            "runtimes": {
                "codex": {
                    "models": [
                        {
                            "key": "private-model",
                            "displayLabel": "Private model",
                            "sortOrder": 1,
                            "efforts": [
                                {"key": "private-effort", "displayLabel": "Private effort", "sortOrder": 1}
                            ],
                        }
                    ]
                }
            }
        },
    )
    assert initial.status_code == 200, initial.text

    async def raw_models() -> str:
        async with client.app.state.store.engine.connect() as conn:
            return (
                await conn.execute(
                    select(user_agent_defaults_t.c.models_json).where(
                        user_agent_defaults_t.c.user_id == ADMIN_USER,
                        user_agent_defaults_t.c.runtime == "codex",
                    )
                )
            ).scalar_one()

    before_empty_patch = asyncio.run(raw_models())
    no_op = client.patch("/agents/defaults", headers=headers, json={"runtimes": {"codex": {}}})
    assert no_op.status_code == 200, no_op.text
    assert asyncio.run(raw_models()) == before_empty_patch

    clear = client.patch(
        "/agents/defaults",
        headers=headers,
        json={"runtimes": {"codex": {"models": []}}},
    )
    assert clear.status_code == 200, clear.text
    assert asyncio.run(raw_models()) == "[]"
    # `[]` is explicit global catalog selection, not a malformed snapshot.
    assert clear.json()["runtimes"]["codex"]["models"][0]["key"] == "gpt-5.6-sol"


def test_malformed_persisted_models_are_observable_and_never_rewritten(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    seeded = client.patch(
        "/agents/defaults",
        headers=headers,
        json={
            "runtimes": {
                "codex": {
                    "models": [
                        {
                            "key": "private-model",
                            "displayLabel": "Private model",
                            "sortOrder": 1,
                            "efforts": [],
                        }
                    ]
                }
            }
        },
    )
    assert seeded.status_code == 200, seeded.text
    connector_id, _, session_id, _ = create_connector_and_session(client)

    corrupt = "{not-json"

    async def corrupt_and_read() -> str:
        async with client.app.state.store.engine.begin() as conn:
            await conn.execute(
                update(user_agent_defaults_t)
                .where(
                    user_agent_defaults_t.c.user_id == ADMIN_USER,
                    user_agent_defaults_t.c.runtime == "codex",
                )
                .values(models_json=corrupt)
            )
        async with client.app.state.store.engine.connect() as conn:
            return (
                await conn.execute(
                    select(user_agent_defaults_t.c.models_json).where(
                        user_agent_defaults_t.c.user_id == ADMIN_USER,
                        user_agent_defaults_t.c.runtime == "codex",
                    )
                )
            ).scalar_one()

    assert asyncio.run(corrupt_and_read()) == corrupt
    assert client.get("/agents/defaults", headers=headers).status_code == 500
    assert client.get("/agents/codex/models", headers=headers).status_code == 500
    assert client.get("/agents/codex/efforts", headers=headers).status_code == 500
    assert client.patch(
        "/agents/defaults",
        headers=headers,
        json={"runtimes": {"codex": {"models": []}}},
    ).status_code == 500
    assert client.patch(
        f"/connectors/{connector_id}/agents/codex/settings",
        headers=headers,
        json={"settings": {"effort": "medium"}},
    ).status_code == 500
    assert client.patch(
        f"/sessions/{session_id}/runtime-settings",
        headers=headers,
        json={"settings": {"effort": "medium"}},
    ).status_code == 500

    client.app.state.rpc = FakeRpc()
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()
    send = client.post(
        f"/sessions/{session_id}/messages",
        headers=headers,
        json={"content": "hi"},
    )
    assert send.status_code == 500, send.text
    assert send.json()["detail"] == "invalid persisted runtime settings"

    async def read_raw() -> str:
        async with client.app.state.store.engine.connect() as conn:
            return (
                await conn.execute(
                    select(user_agent_defaults_t.c.models_json).where(
                        user_agent_defaults_t.c.user_id == ADMIN_USER,
                        user_agent_defaults_t.c.runtime == "codex",
                    )
                )
            ).scalar_one()

    assert asyncio.run(read_raw()) == corrupt


def test_user_agent_defaults_customize_schema_and_new_connectors(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    defaults = client.get("/agents/defaults", headers=headers)
    assert defaults.status_code == 200, defaults.text
    assert defaults.json()["runtimes"]["codex"]["enabled"] is True
    assert defaults.json()["runtimes"]["codex"]["settings"]["model"] == "gpt-5.6-sol"
    assert defaults.json()["runtimes"]["codex"]["settings"]["effort"] == "medium"
    assert "runMode" not in defaults.json()["runtimes"]["claude"]["settings"]

    updated = client.patch(
        "/agents/defaults",
        headers=headers,
        json={
            "runtimes": {
                "codex": {
                    "models": [
                        {
                            "key": "gpt-custom",
                            "displayLabel": "GPT Custom",
                            "sortOrder": 1,
                            "efforts": [
                                {
                                    "key": "custom-effort",
                                    "displayLabel": "Custom Effort",
                                    "sortOrder": 1,
                                }
                            ],
                        }
                    ],
                },
                "claude": {
                    "models": [
                        {
                            "key": "claude-custom",
                            "displayLabel": "Claude Custom",
                            "sortOrder": 1,
                            "efforts": [
                                {
                                    "key": "high",
                                    "displayLabel": "High",
                                    "sortOrder": 1,
                                }
                            ],
                        }
                    ],
                },
            }
        },
    )
    assert updated.status_code == 200, updated.text
    body = updated.json()["runtimes"]
    assert body["codex"]["enabled"] is True
    assert body["codex"]["settings"]["permissionMode"] == "ask"
    assert body["codex"]["models"][0]["key"] == "gpt-custom"
    assert body["codex"]["models"][0]["efforts"][0]["key"] == "custom-effort"

    schema = client.get("/agents/codex/config-schema", headers=headers)
    assert schema.status_code == 200, schema.text
    fields = {field["key"]: field for field in schema.json()["schema"]["fields"]}
    assert fields["model"]["options"][0]["value"] == "gpt-custom"
    assert fields["model"]["options"][0]["label"] == "GPT Custom"
    assert fields["model"]["options"][0]["efforts"][0]["value"] == "custom-effort"
    assert fields["model"]["options"][0]["efforts"][0]["label"] == "Custom Effort"

    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert connector_response.status_code == 200, connector_response.text
    connector_id = connector_response.json()["connector"]["id"]

    codex_settings = client.get(
        f"/connectors/{connector_id}/agents/codex/settings",
        headers=headers,
    )
    assert codex_settings.status_code == 200, codex_settings.text
    assert codex_settings.json()["settings"]["permissionMode"] == "ask"
    assert codex_settings.json()["settings"]["model"] == "gpt-custom"
    assert codex_settings.json()["settings"]["effort"] == "custom-effort"

    claude_settings = client.get(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
    )
    assert claude_settings.status_code == 200, claude_settings.text
    assert "runMode" not in claude_settings.json()["settings"]
    assert claude_settings.json()["settings"]["permissionMode"] == "acceptEdits"


def test_user_agent_defaults_ignore_default_flags(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    response = client.patch(
        "/agents/defaults",
        headers=headers,
        json={
            "runtimes": {
                "codex": {
                    "models": [
                        {
                            "key": "gpt-first",
                            "displayLabel": "GPT First",
                            "isDefault": False,
                            "sortOrder": 1,
                            "efforts": [
                                {
                                    "key": "lowish",
                                    "displayLabel": "Lowish",
                                    "isDefault": False,
                                    "sortOrder": 1,
                                },
                                {
                                    "key": "highish",
                                    "displayLabel": "Highish",
                                    "isDefault": True,
                                    "sortOrder": 2,
                                },
                            ],
                        },
                        {
                            "key": "gpt-second",
                            "displayLabel": "GPT Second",
                            "isDefault": True,
                            "sortOrder": 2,
                            "efforts": [],
                        },
                    ],
                },
            },
        },
    )

    assert response.status_code == 200, response.text
    models = response.json()["runtimes"]["codex"]["models"]
    assert [(entry["key"], entry["isDefault"]) for entry in models] == [
        ("gpt-first", True),
        ("gpt-second", False),
    ]
    assert [(entry["key"], entry["isDefault"]) for entry in models[0]["efforts"]] == [
        ("lowish", True),
        ("highish", False),
    ]


def test_codex_catalog_upgrade_inherits_only_legacy_builtin_snapshots(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    legacy_update = client.patch(
        "/agents/defaults",
        headers=headers,
        json={"runtimes": {"codex": {"models": legacy_codex_models()}}},
    )
    assert legacy_update.status_code == 200, legacy_update.text

    asyncio.run(
        client.app.state.store.create_user(
            user_id="user2",
            password="secret2",
        )
    )
    custom_headers = auth_headers(client, user_id="user2", password="secret2")
    custom_models = legacy_codex_models()
    custom_models[0]["description"] = "Private deployment"
    custom_update = client.patch(
        "/agents/defaults",
        headers=custom_headers,
        json={"runtimes": {"codex": {"models": custom_models}}},
    )
    assert custom_update.status_code == 200, custom_update.text
    custom_before = custom_update.json()["runtimes"]["codex"]["models"]

    explicit_connector = client.post(
        "/connectors",
        headers=headers,
        json={"name": "explicit"},
    ).json()["connector"]["id"]
    explicit = client.patch(
        f"/connectors/{explicit_connector}/agents/codex/settings",
        headers=headers,
        json={"settings": {"model": "gpt-5.5", "effort": "xhigh"}},
    )
    assert explicit.status_code == 200, explicit.text

    null_connector = client.post(
        "/connectors",
        headers=headers,
        json={"name": "null-defaults"},
    ).json()["connector"]["id"]
    cleared = client.patch(
        f"/connectors/{null_connector}/agents/codex/settings",
        headers=headers,
        json={"settings": {"model": None, "effort": None}},
    )
    assert cleared.status_code == 200, cleared.text

    async def cleared_schema_version() -> int:
        async with client.app.state.store.engine.connect() as conn:
            return (
                await conn.execute(
                    select(device_agent_settings_t.c.schema_version).where(
                        device_agent_settings_t.c.connector_id == null_connector,
                        device_agent_settings_t.c.runtime == "codex",
                    )
                )
            ).scalar_one()

    assert asyncio.run(cleared_schema_version()) == 3

    async def downgrade_and_reseed() -> None:
        legacy_schema = deepcopy(DEFAULT_RUNTIME_CONFIG_SCHEMAS["codex"]).model_dump(
            exclude_none=True
        )
        legacy_schema["schemaVersion"] = 3
        for field in legacy_schema["fields"]:
            if field["key"] == "model":
                field["options"] = [
                    option
                    for option in field["options"]
                    if not str(option["value"]).startswith("gpt-5.6-")
                ]
            elif field["key"] == "effort":
                field["options"] = [
                    option
                    for option in field["options"]
                    if option["value"] not in {"max", "ultra"}
                ]
            for option in field.get("options") or []:
                option["isDefault"] = False
        await client.app.state.store.set_runtime_config_schema("codex", legacy_schema)

        async with client.app.state.store.engine.begin() as conn:
            await conn.execute(
                delete(agent_models_t).where(
                    agent_models_t.c.runtime == "codex",
                    agent_models_t.c.key.in_(
                        {"gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"}
                    ),
                )
            )
            await conn.execute(
                delete(agent_efforts_t).where(
                    agent_efforts_t.c.runtime == "codex",
                    agent_efforts_t.c.key.in_({"max", "ultra"}),
                )
            )
            await conn.execute(
                update(agent_models_t)
                .where(agent_models_t.c.runtime == "codex")
                .values(is_default=0)
            )
            await conn.execute(
                update(agent_efforts_t)
                .where(agent_efforts_t.c.runtime == "codex")
                .values(is_default=0)
            )
            for sort_order, key in enumerate(
                ("gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2"),
                start=1,
            ):
                await conn.execute(
                    update(agent_models_t)
                    .where(agent_models_t.c.runtime == "codex", agent_models_t.c.key == key)
                    .values(is_default=1 if key == "gpt-5.5" else 0, sort_order=sort_order)
                )
            await conn.execute(
                update(agent_efforts_t)
                .where(
                    agent_efforts_t.c.runtime == "codex",
                    agent_efforts_t.c.key == "xhigh",
                )
                .values(is_default=1)
            )

        await client.app.state.store.seed_agent_catalog()
        await client.app.state.store.seed_runtime_config_schemas()
        await client.app.state.store.seed_agent_catalog()
        await client.app.state.store.seed_runtime_config_schemas()

    asyncio.run(downgrade_and_reseed())

    async def persisted_models(user_id: str) -> list[dict[str, Any]]:
        async with client.app.state.store.engine.connect() as conn:
            raw = (
                await conn.execute(
                    select(user_agent_defaults_t.c.models_json).where(
                        user_agent_defaults_t.c.user_id == user_id,
                        user_agent_defaults_t.c.runtime == "codex",
                    )
                )
            ).scalar_one()
        return json.loads(raw)

    persisted_legacy_snapshot = asyncio.run(persisted_models("user1"))
    assert [model["key"] for model in persisted_legacy_snapshot] == [
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex",
        "gpt-5.2",
    ]

    upgraded = client.get("/agents/defaults", headers=headers).json()["runtimes"]["codex"]
    assert [model["key"] for model in upgraded["models"]][:4] == [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
    ]
    assert [model["key"] for model in upgraded["models"] if model["isDefault"]] == [
        "gpt-5.6-sol"
    ]
    assert [
        effort["key"]
        for effort in upgraded["models"][0]["efforts"]
        if effort["isDefault"]
    ] == ["medium"]

    custom_after = client.get("/agents/defaults", headers=custom_headers).json()["runtimes"][
        "codex"
    ]["models"]
    assert custom_after == custom_before

    explicit_after = client.get(
        f"/connectors/{explicit_connector}/agents/codex/settings",
        headers=headers,
    ).json()["settings"]
    assert explicit_after["model"] == "gpt-5.5"
    assert explicit_after["effort"] == "xhigh"

    null_after = client.get(
        f"/connectors/{null_connector}/agents/codex/settings",
        headers=headers,
    ).json()["settings"]
    assert null_after["model"] == "gpt-5.6-sol"
    assert null_after["effort"] == "medium"

    schema = client.get("/agents/codex/config-schema", headers=headers).json()["schema"]
    assert schema["schemaVersion"] == 4

    models = asyncio.run(client.app.state.store.list_agent_models("codex"))
    efforts = asyncio.run(client.app.state.store.list_agent_efforts("codex"))
    # Durable rows intentionally remain readable by a base-main rollback;
    # the v4/GPT-5.6 catalog above is an in-memory projection.
    assert [model.key for model in models if model.isDefault] == ["gpt-5.5"]
    assert [effort.key for effort in efforts if effort.isDefault] == ["xhigh"]


def test_first_discovery_respects_user_agent_default_enabled(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    disabled = client.patch("/agents/defaults", headers=headers, json={"runtimes": {"codex": {}}})
    assert disabled.status_code == 200, disabled.text
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]

    state = asyncio.run(
        client.app.state.store.apply_discovery(
            connector_id,
                {
                    "runtimes": {
                        "codex": {
                            "history": "ok",
                            "execution": "ok",
                            "selected": {"source": "cli", "path": "/usr/bin/codex"},
                        },
                        "claude": {
                            "history": "ok",
                            "execution": "ok",
                            "selected": {"source": "cli", "path": "/usr/bin/claude"},
                        },
                    }
                },
            )
    )

    assert "claude" in state["attached"]
    assert "codex" in state["attached"]
    assert "codex" not in state["disabled"]


def test_device_agent_settings_patch_and_read(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)

    initial = client.get(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
    )
    assert initial.status_code == 200, initial.text
    assert "runMode" not in initial.json()["settings"]
    assert "defaultRunModeConfigured" not in initial.json()

    model_only = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"model": "claude-sonnet-4-6"}},
    )
    assert model_only.status_code == 200, model_only.text
    assert "defaultRunModeConfigured" not in model_only.json()

    invalid = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"runMode": "terminal"}},
    )
    assert invalid.status_code == 422

    response = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={
            "settings": {
                "permissionMode": "plan",
                "model": "claude-sonnet-4-6",
                "effort": "high",
            }
        },
    )

    assert response.status_code == 200, response.text
    settings = response.json()["settings"]
    assert "runMode" not in settings
    assert settings["permissionMode"] == "plan"
    assert settings["model"] == "claude-sonnet-4-6"
    assert settings["effort"] == "high"
    assert "defaultRunModeConfigured" not in response.json()

    read_back = client.get(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
    )
    assert read_back.status_code == 200
    assert read_back.json()["settings"] == settings
    assert "defaultRunModeConfigured" not in read_back.json()


def test_session_runtime_settings_rejects_claude_run_mode(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]
    session = asyncio.run(
        client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id="sess_claude_run_mode_flag",
            runtime="claude",
            external_session_id="uuid-claude-run-mode-flag",
            title="Claude",
            cwd="/repo",
            status="idle",
        )
    )

    initial = client.get(f"/sessions/{session.id}/runtime-settings", headers=headers)
    assert initial.status_code == 200, initial.text
    assert "runMode" not in initial.json()["runtimeSettings"]
    assert "defaultRunModeConfigured" not in initial.json()

    rejected = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"runMode": "terminal"}},
    )
    assert rejected.status_code == 422

    after = client.get(f"/sessions/{session.id}/runtime-settings", headers=headers)
    assert after.status_code == 200, after.text
    assert "runMode" not in after.json()["runtimeSettings"]
    assert "defaultRunModeConfigured" not in after.json()


def test_claude_effort_options_are_constrained_by_model(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, _, headers = create_connector_and_session(client)

    opus = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"model": "claude-opus-4-7[1m]", "effort": "xhigh"}},
    )
    assert opus.status_code == 200, opus.text
    assert opus.json()["settings"]["effort"] == "xhigh"

    sonnet_bad = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"model": "claude-sonnet-4-6", "effort": "xhigh"}},
    )
    assert sonnet_bad.status_code == 422

    haiku = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"model": "claude-haiku-4-5"}},
    )
    assert haiku.status_code == 200, haiku.text
    assert haiku.json()["settings"]["model"] == "claude-haiku-4-5"
    assert haiku.json()["settings"]["effort"] is None

    haiku_bad = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"effort": "low"}},
    )
    assert haiku_bad.status_code == 422


def test_codex_effort_options_are_constrained_by_model(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)

    schema_response = client.get("/agents/codex/config-schema", headers=headers)
    assert schema_response.status_code == 200, schema_response.text
    schema = schema_response.json()["schema"]
    assert schema["schemaVersion"] == 4
    fields = {field["key"]: field for field in schema["fields"]}
    models = {option["value"]: option for option in fields["model"]["options"]}
    assert list(models)[:4] == [
        "gpt-5.6-sol",
        "gpt-5.6-terra",
        "gpt-5.6-luna",
        "gpt-5.5",
    ]
    assert [item["value"] for item in models["gpt-5.6-sol"]["efforts"]] == [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
    ]
    assert [item["value"] for item in models["gpt-5.6-terra"]["efforts"]] == [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
        "ultra",
    ]
    assert [item["value"] for item in models["gpt-5.6-luna"]["efforts"]] == [
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
    ]
    assert [item["value"] for item in models["gpt-5.5"]["efforts"]] == [
        "low",
        "medium",
        "high",
        "xhigh",
    ]

    accepted = (
        ("gpt-5.6-sol", "ultra"),
        ("gpt-5.6-terra", "ultra"),
        ("gpt-5.6-luna", "max"),
        ("gpt-5.5", "xhigh"),
    )
    for model, effort in accepted:
        response = client.patch(
            f"/connectors/{connector_id}/agents/codex/settings",
            headers=headers,
            json={"settings": {"model": model, "effort": effort}},
        )
        assert response.status_code == 200, response.text

    rejected = (
        ("gpt-5.6-luna", "ultra"),
        ("gpt-5.5", "max"),
    )
    for model, effort in rejected:
        response = client.patch(
            f"/connectors/{connector_id}/agents/codex/settings",
            headers=headers,
            json={"settings": {"model": model, "effort": effort}},
        )
        assert response.status_code == 422

    session_ok = client.patch(
        f"/sessions/{session_id}/runtime-settings",
        headers=headers,
        json={"settings": {"model": "gpt-5.6-sol", "effort": "medium"}},
    )
    assert session_ok.status_code == 200, session_ok.text
    session_bad = client.patch(
        f"/sessions/{session_id}/runtime-settings",
        headers=headers,
        json={"settings": {"model": "gpt-5.6-luna", "effort": "ultra"}},
    )
    assert session_bad.status_code == 422


def test_codex_sol_medium_defaults_are_sent_to_connector(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)

    device_settings = client.get(
        f"/connectors/{connector_id}/agents/codex/settings",
        headers=headers,
    )
    assert device_settings.status_code == 200, device_settings.text
    assert device_settings.json()["settings"]["model"] == "gpt-5.6-sol"
    assert device_settings.json()["settings"]["effort"] == "medium"

    fake_rpc = FakeRpc()
    client.app.state.rpc = fake_rpc
    client.post(f"/sessions/{session_id}/takeover", headers=headers).raise_for_status()
    sent = client.post(
        f"/sessions/{session_id}/messages",
        headers=headers,
        json={"content": "use the product defaults"},
    )
    assert sent.status_code == 200, sent.text
    connector_id_sent, method, params = fake_rpc.requests[-1]
    assert connector_id_sent == connector_id
    assert method == "turn.start"
    assert params["model"] == "gpt-5.6-sol"
    assert params["effort"] == "medium"


def test_automatic_codex_defaults_are_durable_but_projected_as_sol_medium(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)

    # Materialize the user-default row through an automatic catalog update.
    # It must not write the current server's model/effort as a durable choice.
    defaults = client.patch(
        "/agents/defaults",
        headers=headers,
        json={"runtimes": {"codex": {"models": []}}},
    )
    assert defaults.status_code == 200, defaults.text
    assert defaults.json()["runtimes"]["codex"]["settings"] == {
        "permissionMode": "ask",
        "model": "gpt-5.6-sol",
        "effort": "medium",
    }

    connector = client.post("/connectors", headers=headers, json={"name": "dev"})
    assert connector.status_code == 200, connector.text
    connector_id = connector.json()["connector"]["id"]

    # A non-model settings patch still inherits the model and effort.
    permission = client.patch(
        f"/connectors/{connector_id}/agents/codex/settings",
        headers=headers,
        json={"settings": {"permissionMode": "auto"}},
    )
    assert permission.status_code == 200, permission.text
    assert permission.json()["settings"] == {
        "permissionMode": "auto",
        "model": "gpt-5.6-sol",
        "effort": "medium",
    }

    automatic = client.post(
        "/sessions",
        headers=headers,
        json={
            "connectorId": connector_id,
            "runtime": "codex",
            "externalSessionId": "thr_automatic_defaults",
            "title": "Automatic defaults",
            "cwd": "/repo",
        },
    )
    assert automatic.status_code == 200, automatic.text
    assert automatic.json()["session"]["runtimeSettings"]["model"] == "gpt-5.6-sol"
    assert automatic.json()["session"]["runtimeSettings"]["effort"] == "medium"

    async def raw_automatic() -> tuple[str, dict[str, Any], str]:
        async with client.app.state.store.engine.connect() as conn:
            user_defaults = (
                await conn.execute(
                    select(user_agent_defaults_t.c.settings_json).where(
                        user_agent_defaults_t.c.user_id == ADMIN_USER,
                        user_agent_defaults_t.c.runtime == "codex",
                    )
                )
            ).scalar_one()
            device = (
                await conn.execute(
                    select(
                        device_agent_settings_t.c.settings_json,
                        device_agent_settings_t.c.schema_version,
                    ).where(
                        device_agent_settings_t.c.connector_id == connector_id,
                        device_agent_settings_t.c.runtime == "codex",
                    )
                )
            ).mappings().one()
            session = (
                await conn.execute(
                    select(sessions_t.c.runtime_settings_override).where(
                        sessions_t.c.id == automatic.json()["session"]["id"]
                    )
                )
            ).scalar_one()
        return user_defaults, dict(device), session

    durable_defaults, durable_device, durable_session = asyncio.run(raw_automatic())
    assert json.loads(durable_defaults)["model"] is None
    assert json.loads(durable_defaults)["effort"] is None
    assert json.loads(durable_device["settings_json"]) == {
        "permissionMode": "auto",
        "model": None,
        "effort": None,
    }
    assert durable_device["schema_version"] == 3
    assert json.loads(durable_session) == {
        "permissionMode": "auto",
        "model": None,
        "effort": None,
    }
    assert all("gpt-5.6" not in raw for raw in (durable_defaults, durable_device["settings_json"], durable_session))

    # An explicit selection equal to the current default is still a user
    # choice and therefore must not be collapsed to nullable inheritance.
    explicit = client.patch(
        f"/connectors/{connector_id}/agents/codex/settings",
        headers=headers,
        json={"settings": {"model": "gpt-5.6-sol", "effort": "medium"}},
    )
    assert explicit.status_code == 200, explicit.text

    async def raw_explicit() -> tuple[dict[str, Any], str]:
        async with client.app.state.store.engine.connect() as conn:
            device = (
                await conn.execute(
                    select(
                        device_agent_settings_t.c.settings_json,
                        device_agent_settings_t.c.schema_version,
                    ).where(
                        device_agent_settings_t.c.connector_id == connector_id,
                        device_agent_settings_t.c.runtime == "codex",
                    )
                )
            ).mappings().one()
        return dict(device), device["settings_json"]

    explicit_device, explicit_device_json = asyncio.run(raw_explicit())
    assert json.loads(explicit_device_json)["model"] == "gpt-5.6-sol"
    assert json.loads(explicit_device_json)["effort"] == "medium"
    assert explicit_device["schema_version"] == 4


def test_custom_model_efforts_drive_runtime_settings_validation(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    defaults = client.patch(
        "/agents/defaults",
        headers=headers,
        json={
            "runtimes": {
                "codex": {
                    "models": [
                        {
                            "key": "gpt-third-party",
                            "displayLabel": "GPT Third Party",
                            "sortOrder": 1,
                            "efforts": [
                                {
                                    "key": "balanced",
                                    "displayLabel": "Balanced",
                                    "sortOrder": 1,
                                }
                            ],
                        },
                        {
                            "key": "gpt-other",
                            "displayLabel": "GPT Other",
                            "sortOrder": 2,
                            "efforts": [
                                {
                                    "key": "other-effort",
                                    "displayLabel": "Other Effort",
                                    "sortOrder": 1,
                                }
                            ],
                        }
                    ],
                }
            }
        },
    )
    assert defaults.status_code == 200, defaults.text

    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]

    ok = client.patch(
        f"/connectors/{connector_id}/agents/codex/settings",
        headers=headers,
        json={"settings": {"model": "gpt-third-party", "effort": "balanced"}},
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["settings"]["model"] == "gpt-third-party"
    assert ok.json()["settings"]["effort"] == "balanced"

    wrong_model_effort = client.patch(
        f"/connectors/{connector_id}/agents/codex/settings",
        headers=headers,
        json={"settings": {"effort": "other-effort"}},
    )
    assert wrong_model_effort.status_code == 422

    bad = client.patch(
        f"/connectors/{connector_id}/agents/codex/settings",
        headers=headers,
        json={"settings": {"effort": "high"}},
    )
    assert bad.status_code == 422


def test_session_runtime_settings_override_respects_schema(tmp_path):
    client = make_client(tmp_path)
    connector_id, _, session_id, headers = create_connector_and_session(client)

    response = client.patch(
        f"/sessions/{session_id}/runtime-settings",
        headers=headers,
        json={"settings": {"permissionMode": "fullAccess"}},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["runtimeSettingsOverride"] == {
        "permissionMode": "fullAccess",
        "model": "gpt-5.6-sol",
        "effort": "medium",
    }
    assert body["runtimeSettings"]["permissionMode"] == "fullAccess"

    bad = client.patch(
        f"/sessions/{session_id}/runtime-settings",
        headers=headers,
        json={"settings": {"runMode": "terminal"}},
    )
    assert bad.status_code == 422

    raw_codex_config = client.patch(
        f"/sessions/{session_id}/runtime-settings",
        headers=headers,
        json={"settings": {"approvalPolicy": "never"}},
    )
    assert raw_codex_config.status_code == 422


def test_session_claude_effort_patch_uses_effective_model(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]

    asyncio.run(
        client.app.state.store.patch_device_agent_settings(
            connector_id,
            "claude",
            {"model": "claude-opus-4-7[1m]"},
        )
    )
    session = asyncio.run(
        client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id="sess_claude_effort",
            runtime="claude",
            external_session_id="uuid-claude-effort",
            title="Claude",
            cwd="/repo",
            status="idle",
        )
    )

    effort = client.patch(
        f"/sessions/{session.id}/runtime-settings",
        headers=headers,
        json={"settings": {"effort": "xhigh"}},
    )
    assert effort.status_code == 200, effort.text
    assert effort.json()["runtimeSettingsOverride"] == {
        "permissionMode": "acceptEdits",
        "model": "claude-opus-4-7[1m]",
        "effort": "xhigh",
    }
    assert effort.json()["runtimeSettings"]["model"] == "claude-opus-4-7[1m]"
    assert effort.json()["runtimeSettings"]["effort"] == "xhigh"

    sonnet = client.patch(
        f"/sessions/{session.id}/runtime-settings",
        headers=headers,
        json={"settings": {"model": "claude-sonnet-4-6"}},
    )
    assert sonnet.status_code == 200, sonnet.text
    assert sonnet.json()["runtimeSettingsOverride"] == {
        "permissionMode": "acceptEdits",
        "model": "claude-sonnet-4-6"
    }
    assert sonnet.json()["runtimeSettings"]["model"] == "claude-sonnet-4-6"
    assert sonnet.json()["runtimeSettings"]["effort"] is None

    asyncio.run(
        client.app.state.store.patch_device_agent_settings(
            connector_id,
            "claude",
            {"model": "claude-haiku-4-5"},
        )
    )
    haiku_session = asyncio.run(
        client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id="sess_claude_haiku_effort",
            runtime="claude",
            external_session_id="uuid-claude-haiku-effort",
            title="Claude Haiku",
            cwd="/repo",
            status="idle",
        )
    )
    haiku_bad = client.patch(
        f"/sessions/{haiku_session.id}/runtime-settings",
        headers=headers,
        json={"settings": {"effort": "low"}},
    )
    assert haiku_bad.status_code == 422


def test_effective_runtime_settings_priority_and_effort_constraints(tmp_path):
    client = make_client(tmp_path)
    headers = auth_headers(client)
    connector_response = client.post("/connectors", headers=headers, json={"name": "dev"})
    connector_id = connector_response.json()["connector"]["id"]

    session = asyncio.run(
        client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id="sess_claude_cfg",
            runtime="claude",
            external_session_id="uuid-claude-cfg",
            title="Claude",
            cwd="/repo",
            status="idle",
        )
    )

    override = client.patch(
        f"/sessions/{session.id}/runtime-settings",
        headers=headers,
        json={
            "settings": {
                "permissionMode": "default",
                "model": "claude-sonnet-4-6",
            }
        },
    )
    assert override.status_code == 200, override.text

    state = client.get(f"/sessions/{session.id}/runtime-settings", headers=headers)
    assert state.status_code == 200
    body = state.json()
    assert "effectiveRunMode" not in body
    assert "runMode" not in body["runtimeSettings"]
    assert body["runtimeSettings"]["permissionMode"] == "default"
    assert body["runtimeSettings"]["model"] == "claude-sonnet-4-6"
    assert body["runtimeSettings"]["effort"] is None


def test_changing_claude_settings_does_not_interrupt_running_sessions(tmp_path):
    client = make_client(tmp_path)
    connector_id, access_token, _, headers = create_connector_and_session(client)
    fake_rpc = FakeRpc()
    client.app.state.rpc = fake_rpc

    async def seed() -> str:
        session = await client.app.state.store.upsert_connector_session(
            connector_id=connector_id,
            session_id="sess_claude_running",
            runtime="claude",
            external_session_id="uuid-claude-running",
            title="Claude",
            cwd="/repo",
            status="running",
        )
        await client.app.state.store.set_connector_status(connector_id, "online")
        await client.app.state.store.start_active_run(
            session_id=session.id,
            runtime="claude",
            external_session_id="uuid-claude-running",
            turn_id="turn_running_1",
        )
        return session.id

    session_id = asyncio.run(seed())

    response = client.patch(
        f"/connectors/{connector_id}/agents/claude/settings",
        headers=headers,
        json={"settings": {"model": "claude-opus-4-7[1m]", "effort": "xhigh"}},
    )

    assert response.status_code == 200, response.text
    assert response.json()["settings"]["model"] == "claude-opus-4-7[1m]"
    assert response.json()["settings"]["effort"] == "xhigh"
    assert fake_rpc.requests == []
