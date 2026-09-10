from __future__ import annotations

import ast
from pathlib import Path

PACKAGE_ROOT = Path(__file__).parents[1] / "agent_server"


def _imports(path: Path) -> set[str]:
    modules: set[str] = set()
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            modules.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            modules.add(node.module)
    return modules


def _violations(layer: str, forbidden: tuple[str, ...]) -> list[str]:
    result: list[str] = []
    for path in sorted((PACKAGE_ROOT / layer).glob("*.py")):
        for module in sorted(_imports(path)):
            if module == forbidden or module.startswith(forbidden):
                result.append(f"{path.relative_to(PACKAGE_ROOT)} -> {module}")
    return result


def test_core_does_not_depend_on_outer_layers() -> None:
    assert _violations(
        "core",
        (
            "agent_server.api",
            "agent_server.infra",
            "agent_server.services",
            "fastapi",
            "starlette",
        ),
    ) == []


def test_services_do_not_depend_on_transport_or_store_facade() -> None:
    assert _violations(
        "services",
        (
            "agent_server.api",
            "agent_server.infra.repositories.facade",
            "fastapi",
            "starlette",
        ),
    ) == []
