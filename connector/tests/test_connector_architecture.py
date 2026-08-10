from __future__ import annotations

import ast
from pathlib import Path

CONNECTOR_PACKAGE = Path(__file__).resolve().parents[1] / "connector"
TESTS_PACKAGE = Path(__file__).resolve().parents[1] / "tests"

ALLOWED_ROOT_MODULES = {
    "__init__.py",
    "cli.py",
    "control.py",
    "launch.py",
    "logging.py",
    "paths.py",
    "time.py",
}

FORBIDDEN_ACTIVE_IMPORTS = {
    "connector.adapter",
    "connector.attachments",
    "connector.claude",
    "connector.codex",
    "connector.interactions",
    "connector.json_rpc",
    "connector.local_ops",
    "connector.local_runtime",
    "connector.protocol",
    "connector.protocol_catalogs",
    "connector.protocol_revision",
    "connector.runtime",
    "connector.runtime_discovery",
    "connector.runtime_lifecycle",
    "connector.sync_state",
}

FORBIDDEN_ACTIVE_TOKENS = {
    "backendNotifications",
    "notification_sink",
    "approval.requested",
    "protocol.modelCatalogUpdated",
    "protocol.permissionCatalogUpdated",
    "CodexAdapter",
    "ClaudeSdkAdapter",
    "EmptyCodexClient",
}

FORBIDDEN_ACTIVE_CODEX_TOKENS = {
    "app_server_client",
    "CodexAppServerClient",
    "JsonRpcStdioClient",
    "CodexIpcClient",
    "CodexIpcPublisher",
    "thread-follower-start-turn",
    "thread-follower-interrupt-turn",
    "ipcEnabled",
    "sdkMode",
}


def _active_python_files() -> list[Path]:
    return [
        path
        for path in CONNECTOR_PACKAGE.rglob("*.py")
        if "_reference" not in path.relative_to(CONNECTOR_PACKAGE).parts
    ]


def _active_test_files() -> list[Path]:
    return [
        path
        for path in TESTS_PACKAGE.rglob("*.py")
        if "_reference" not in path.relative_to(TESTS_PACKAGE).parts
    ]


def _imported_modules(path: Path) -> list[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    modules: list[str] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.append(node.module)
    return modules


def test_connector_root_only_contains_entrypoints_and_cross_layer_utilities() -> None:
    root_modules = {path.name for path in CONNECTOR_PACKAGE.glob("*.py")}

    assert root_modules <= ALLOWED_ROOT_MODULES


def test_active_connector_code_does_not_import_deprecated_root_modules() -> None:
    violations: list[str] = []

    for path in _active_python_files():
        for module in _imported_modules(path):
            if module in FORBIDDEN_ACTIVE_IMPORTS or module.startswith(
                "connector._reference"
            ):
                relative_path = path.relative_to(CONNECTOR_PACKAGE.parent)
                violations.append(f"{relative_path}: imports {module}")

    assert violations == []


def test_active_connector_code_does_not_use_legacy_adapter_contract_tokens() -> None:
    violations: list[str] = []

    for path in _active_python_files():
        source = path.read_text(encoding="utf-8")
        for token in FORBIDDEN_ACTIVE_TOKENS:
            if token in source:
                relative_path = path.relative_to(CONNECTOR_PACKAGE.parent)
                violations.append(f"{relative_path}: contains {token}")

    assert violations == []


def test_active_connector_tests_do_not_import_reference_modules() -> None:
    violations: list[str] = []

    for path in _active_test_files():
        for module in _imported_modules(path):
            if module.startswith("connector._reference"):
                relative_path = path.relative_to(TESTS_PACKAGE.parent)
                violations.append(f"{relative_path}: imports {module}")

    assert violations == []


def test_connector_dispatcher_keeps_runtime_and_local_rpc_in_handlers() -> None:
    dispatcher_source = (CONNECTOR_PACKAGE / "server" / "dispatch.py").read_text(
        encoding="utf-8"
    )
    runtime_rpc_source = (CONNECTOR_PACKAGE / "server" / "runtime_rpc.py").read_text(
        encoding="utf-8"
    )
    local_rpc_source = (CONNECTOR_PACKAGE / "server" / "local_rpc.py").read_text(
        encoding="utf-8"
    )

    assert "_dispatch_agent_runtime" not in dispatcher_source
    assert '"fs.prepareDownload"' not in dispatcher_source
    assert '"shell.exec"' not in dispatcher_source
    assert '"terminal.create"' not in dispatcher_source
    assert "class RuntimeRpcHandler" in runtime_rpc_source
    assert "class LocalRpcHandler" in local_rpc_source


def test_runtime_rpc_handler_keeps_session_sync_in_session_coordinator() -> None:
    runtime_rpc_source = (CONNECTOR_PACKAGE / "server" / "runtime_rpc.py").read_text(
        encoding="utf-8"
    )
    session_rpc_source = (
        CONNECTOR_PACKAGE / "server" / "runtime_session_rpc.py"
    ).read_text(encoding="utf-8")

    assert "timeline_sync(" not in runtime_rpc_source
    assert "session_state_update(" not in runtime_rpc_source
    assert "notice_upsert(" not in runtime_rpc_source
    assert "timeline_sync(" in session_rpc_source
    assert "session_state_update(" in session_rpc_source
    assert "notice_upsert(" in session_rpc_source


def test_runtime_rpc_handler_keeps_turn_actions_in_turn_coordinator() -> None:
    runtime_rpc_source = (CONNECTOR_PACKAGE / "server" / "runtime_rpc.py").read_text(
        encoding="utf-8"
    )
    turn_rpc_source = (CONNECTOR_PACKAGE / "server" / "runtime_turn_rpc.py").read_text(
        encoding="utf-8"
    )

    assert "create_and_start_session(" not in runtime_rpc_source
    assert "start_turn(" not in runtime_rpc_source
    assert "steer_turn(" not in runtime_rpc_source
    assert "interrupt_turn(" not in runtime_rpc_source
    assert "respond_interaction(" not in runtime_rpc_source
    assert "create_and_start_session(" in turn_rpc_source
    assert "start_turn(" in turn_rpc_source
    assert "respond_interaction(" in turn_rpc_source


def test_backend_rpc_client_delegates_runtime_sync_to_runner() -> None:
    client_source = (CONNECTOR_PACKAGE / "server" / "client.py").read_text(
        encoding="utf-8"
    )
    runtime_sync_source = (CONNECTOR_PACKAGE / "server" / "runtime_sync.py").read_text(
        encoding="utf-8"
    )

    assert "RuntimeSyncRunner(" in client_source
    assert "session_meta_upsert(" not in client_source
    assert "_preferences_signature" not in client_source
    assert "session_meta_upsert(" in runtime_sync_source
    assert "_preferences_signature" in runtime_sync_source


def test_active_codex_provider_is_sdk_only() -> None:
    provider_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "provider.py"
    ).read_text(encoding="utf-8")

    assert "sdk_client_from_config" in provider_source
    assert "app_server_client" not in provider_source
    assert "sdkMode" not in provider_source
    assert "ipcEnabled" not in provider_source
    assert "executablePath" not in provider_source


def test_codex_runtime_depends_on_transport_protocol_not_transports() -> None:
    runtime_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "runtime.py"
    ).read_text(encoding="utf-8")
    sdk_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "sdk" / "client.py"
    ).read_text(encoding="utf-8")

    assert "CodexRuntimeClient" in runtime_source
    assert ".sdk.client" not in runtime_source
    assert "app_server_client" not in runtime_source
    assert "openai_codex" not in runtime_source
    assert "openai_codex" in sdk_source


def test_active_codex_code_does_not_import_app_server_reference() -> None:
    violations: list[str] = []

    for path in (CONNECTOR_PACKAGE / "runtimes" / "codex").rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        for token in FORBIDDEN_ACTIVE_CODEX_TOKENS:
            if token in source:
                relative_path = path.relative_to(CONNECTOR_PACKAGE.parent)
                violations.append(f"{relative_path}: references {token}")

    assert violations == []


def test_codex_runtime_keeps_state_writes_in_collaborators() -> None:
    runtime_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "runtime.py"
    ).read_text(encoding="utf-8")

    assert "session_states.update(" not in runtime_source
    assert "async def _set_session_state" not in runtime_source


def test_codex_timeline_items_do_not_own_content_projection() -> None:
    items_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "timeline" / "items.py"
    ).read_text(encoding="utf-8")
    content_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "timeline" / "content.py"
    ).read_text(encoding="utf-8")

    assert "codex_timeline_content_from_mapping(" not in items_source
    assert "class MappingTimelineContent" not in items_source
    assert "codex_timeline_content_from_mapping(" in content_source
    assert "class MappingTimelineContent" in content_source


def test_codex_timeline_projection_does_not_own_raw_content_extraction() -> None:
    projection_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "timeline" / "projection.py"
    ).read_text(encoding="utf-8")
    raw_content_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "timeline" / "raw_content.py"
    ).read_text(encoding="utf-8")

    assert "def timeline_item_content(" not in projection_source
    assert "def text_from_value(" not in projection_source
    assert "def timeline_item_content(" in raw_content_source
    assert "def text_from_value(" in raw_content_source


def test_codex_timeline_projection_does_not_own_notification_raw_events() -> None:
    projection_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "timeline" / "projection.py"
    ).read_text(encoding="utf-8")
    events_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "timeline" / "events.py"
    ).read_text(encoding="utf-8")

    assert "def raw_item_from_notification(" not in projection_source
    assert "def notification_delta(" not in projection_source
    assert "def raw_item_from_notification(" in events_source
    assert "def notification_delta(" in events_source


def test_codex_timeline_projection_does_not_own_snapshot_reduction() -> None:
    projection_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "timeline" / "projection.py"
    ).read_text(encoding="utf-8")
    snapshot_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "timeline" / "snapshot.py"
    ).read_text(encoding="utf-8")

    assert "def timeline_items_from_thread(" not in projection_source
    assert "def raw_timeline_items(" not in projection_source
    assert "def timeline_items_from_thread(" in snapshot_source
    assert "def raw_timeline_items(" in snapshot_source


def test_codex_timeline_projection_does_not_own_raw_item_metadata() -> None:
    projection_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "timeline" / "projection.py"
    ).read_text(encoding="utf-8")
    raw_item_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "timeline" / "raw_item.py"
    ).read_text(encoding="utf-8")

    for function_name in (
        "timeline_item_type",
        "timeline_item_status",
        "timeline_raw_type",
        "timeline_raw_status",
        "timeline_item_role",
        "timeline_item_turn_id",
        "timeline_item_revision",
    ):
        assert f"def {function_name}(" not in projection_source
        assert f"def {function_name}(" in raw_item_source


def test_codex_timeline_active_code_does_not_rebuild_projection_as_raw() -> None:
    violations: list[str] = []

    for path in (CONNECTOR_PACKAGE / "runtimes" / "codex" / "timeline").rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        if "to_legacy_raw" in source:
            relative_path = path.relative_to(CONNECTOR_PACKAGE.parent)
            violations.append(f"{relative_path}: contains to_legacy_raw")

    assert violations == []


def test_codex_typed_sdk_timeline_projection_does_not_dump_models() -> None:
    typed_events_source = (
        CONNECTOR_PACKAGE / "runtimes" / "codex" / "timeline" / "typed_events.py"
    ).read_text(encoding="utf-8")

    assert "model_dump" not in typed_events_source
    assert "__dict__" not in typed_events_source
    assert "vars(" not in typed_events_source


def test_codex_notifications_are_split_by_side_effect_role() -> None:
    notifications_dir = CONNECTOR_PACKAGE / "runtimes" / "codex" / "notifications"
    projector_source = (notifications_dir / "projector.py").read_text(encoding="utf-8")
    turn_lifecycle_source = (notifications_dir / "turn_lifecycle.py").read_text(
        encoding="utf-8"
    )
    timeline_activity_source = (notifications_dir / "timeline_activity.py").read_text(
        encoding="utf-8"
    )
    notices_source = (notifications_dir / "notices.py").read_text(encoding="utf-8")

    assert notifications_dir.is_dir()
    assert not (CONNECTOR_PACKAGE / "runtimes" / "codex" / "notifications.py").exists()
    assert "class CodexNotificationProjector" in projector_source
    assert "timeline_sync(" not in projector_source
    assert "timeline_item_upsert(" not in projector_source
    assert "notice_upsert(" not in projector_source
    assert "timeline_sync(" in turn_lifecycle_source
    assert "timeline_item_upsert(" in timeline_activity_source
    assert "notice_upsert(" in notices_source


def test_codex_turn_controller_is_operation_facade() -> None:
    turns_dir = CONNECTOR_PACKAGE / "runtimes" / "codex" / "turns"
    controller_source = (turns_dir / "controller.py").read_text(encoding="utf-8")
    session_start_source = (turns_dir / "session_start.py").read_text(encoding="utf-8")
    selections_source = (turns_dir / "selections.py").read_text(encoding="utf-8")

    assert "start_thread(" not in controller_source
    assert "session_meta_upsert(" not in controller_source
    assert "session_states.update(" not in controller_source
    assert "_set_session_state" not in controller_source
    assert "CodexSessionStartController" in controller_source
    assert "CodexSelectionController" in controller_source
    assert "start_thread(" in session_start_source
    assert "session_meta_upsert(" in session_start_source
    assert "session_states.update(" in selections_source


def test_claude_runtime_keeps_turn_and_sdk_work_in_collaborators() -> None:
    runtime_source = (
        CONNECTOR_PACKAGE / "runtimes" / "claude" / "runtime.py"
    ).read_text(encoding="utf-8")

    for token in (
        "load_sdk(",
        "new_sdk_client(",
        "receive_response_messages(",
        "query_client(",
        "materialize_claude_attachments(",
        "asyncio.create_task(",
        "session_states.update(",
        "_set_session_state",
        "host.timeline_item_upsert(",
        "host.timeline_sync(",
        "host.notice_upsert(",
    ):
        assert token not in runtime_source


def test_claude_notifications_are_split_by_side_effect_role() -> None:
    notifications_dir = CONNECTOR_PACKAGE / "runtimes" / "claude" / "notifications"
    projector_source = (notifications_dir / "projector.py").read_text(encoding="utf-8")
    session_state_source = (notifications_dir / "session_state.py").read_text(
        encoding="utf-8"
    )
    timeline_activity_source = (notifications_dir / "timeline_activity.py").read_text(
        encoding="utf-8"
    )
    notices_source = (notifications_dir / "notices.py").read_text(encoding="utf-8")

    assert notifications_dir.is_dir()
    assert "class ClaudeNotificationProjector" in projector_source
    assert "timeline_sync(" not in projector_source
    assert "timeline_item_upsert(" not in projector_source
    assert "notice_upsert(" not in projector_source
    assert "session_states.update(" in session_state_source
    assert "timeline_sync(" in timeline_activity_source
    assert "timeline_item_upsert(" in timeline_activity_source
    assert "notice_upsert(" in notices_source


def test_claude_turn_controller_is_operation_facade() -> None:
    turns_dir = CONNECTOR_PACKAGE / "runtimes" / "claude" / "turns"
    controller_source = (turns_dir / "controller.py").read_text(encoding="utf-8")
    actions_source = (turns_dir / "actions.py").read_text(encoding="utf-8")
    lifecycle_source = (turns_dir / "lifecycle.py").read_text(encoding="utf-8")
    interactions_source = (turns_dir / "interactions.py").read_text(encoding="utf-8")
    selections_source = (turns_dir / "selections.py").read_text(encoding="utf-8")
    session_start_source = (turns_dir / "session_start.py").read_text(
        encoding="utf-8"
    )

    assert "load_sdk(" not in controller_source
    assert "session_states.update(" not in controller_source
    assert "_set_session_state" not in controller_source
    assert "ClaudeTurnActionHandler" in controller_source
    assert "ClaudeTurnRunner" in controller_source
    assert "ClaudeInteractionController" in controller_source
    assert "ClaudeSelectionController" in controller_source
    assert "ClaudeSessionStartHandler" in controller_source
    assert "asyncio.create_task(" in actions_source
    assert "load_sdk(" in lifecycle_source
    assert "receive_response_messages(" in lifecycle_source
    assert "request_tool_approval(" in interactions_source
    assert "effective_claude_selections(" in selections_source
    assert "session_meta_upsert(" in session_start_source
