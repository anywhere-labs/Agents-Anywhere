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
