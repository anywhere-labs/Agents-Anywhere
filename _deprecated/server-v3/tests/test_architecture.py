from __future__ import annotations

import ast
from pathlib import Path

PACKAGE_ROOT = Path(__file__).parents[1] / "aa_control"


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
    for path in sorted((PACKAGE_ROOT / layer).rglob("*.py")):
        for module in sorted(_imports(path)):
            if module.startswith(forbidden):
                result.append(f"{path.relative_to(PACKAGE_ROOT)} -> {module}")
    return result


def test_core_does_not_depend_on_outer_layers() -> None:
    assert _violations(
        "core",
        (
            "aa_control.api",
            "aa_control.rpc",
            "aa_control.infra",
            "aa_control.services",
            "fastapi",
            "starlette",
            "sqlalchemy",
            "redis",
            "meshcall",
        ),
    ) == []


def test_services_do_not_depend_on_fastapi_or_api() -> None:
    assert _violations(
        "services",
        (
            "aa_control.api",
            "aa_control.rpc",
            "fastapi",
            "starlette",
        ),
    ) == []
