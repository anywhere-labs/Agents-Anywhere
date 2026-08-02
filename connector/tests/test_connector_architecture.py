from __future__ import annotations

import ast
from pathlib import Path

CONNECTOR_PACKAGE = Path(__file__).resolve().parents[1] / "connector"

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


def _active_python_files() -> list[Path]:
    return [
        path
        for path in CONNECTOR_PACKAGE.rglob("*.py")
        if "_reference" not in path.relative_to(CONNECTOR_PACKAGE).parts
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
            if module in FORBIDDEN_ACTIVE_IMPORTS:
                relative_path = path.relative_to(CONNECTOR_PACKAGE.parent)
                violations.append(f"{relative_path}: imports {module}")

    assert violations == []


def test_connector_dispatcher_keeps_runtime_and_local_rpc_in_handlers() -> None:
    dispatcher_source = (CONNECTOR_PACKAGE / "server" / "dispatch.py").read_text(encoding="utf-8")
    runtime_rpc_source = (CONNECTOR_PACKAGE / "server" / "runtime_rpc.py").read_text(encoding="utf-8")
    local_rpc_source = (CONNECTOR_PACKAGE / "server" / "local_rpc.py").read_text(encoding="utf-8")

    assert "_dispatch_agent_runtime" not in dispatcher_source
    assert '"fs.prepareDownload"' not in dispatcher_source
    assert '"shell.exec"' not in dispatcher_source
    assert '"terminal.create"' not in dispatcher_source
    assert "class RuntimeRpcHandler" in runtime_rpc_source
    assert "class LocalRpcHandler" in local_rpc_source
