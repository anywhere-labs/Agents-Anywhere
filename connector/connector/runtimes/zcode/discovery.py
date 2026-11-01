"""Locate the installed ZCode CLI without modifying its configuration."""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ZCodeLaunch:
    executable: str
    arguments: tuple[str, ...]


def discover_zcode(*, app_root: Path | None = None) -> ZCodeLaunch | None:
    """Locate a ZCode CJS entry and a Node executable for the local bridge."""
    app = app_root or Path("/Applications/ZCode.app")
    entry = app / "Contents/Resources/glm/zcode.cjs"
    if not entry.is_file():
        cli = shutil.which("zcode")
        candidate = Path(cli).resolve() if cli else None
        if candidate is None or candidate.suffix != ".cjs" or not candidate.is_file():
            return None
        entry = candidate
    node = shutil.which("node")
    if not node:
        for candidate in (Path("/opt/homebrew/bin/node"), Path("/usr/local/bin/node")):
            if candidate.is_file() and os.access(candidate, os.X_OK):
                node = str(candidate)
                break
    if not node:
        return None
    return ZCodeLaunch(node, (str(entry), "app-server"))


def electron_node_exec(entry: str | Path) -> str | None:
    """ZCode 桌面端 Electron 可执行文件（ELECTRON_RUN_AS_NODE=1 时可当完整 Node 用）。

    引擎 3.17.1+ 依赖 node:sqlite 内置模块；系统里常见精简/老 Node 构建没有
    该模块，而桌面端 Electron 自带的 Node 是完整的。桌面端自己生成的
    node-fallback shim（~/.zcode/cli/node-fallback/v1/node）就是靠这个可执行
    文件工作的。

    优先返回带 LSUIElement 的 Electron Helper——它不会被注册成前台应用。
    主程序二进制没有该标志，被直接 exec 当 Node 用时每个引擎会话都会在 Dock
    上多出一个无图标 "exec" 图标。Helper 缺失时才回退主程序。
    """
    entry_path = Path(entry)
    for parent in entry_path.parents:
        if parent.suffix != ".app":
            continue
        helper = (parent / "Contents/Frameworks" / f"{parent.stem} Helper.app"
                  / "Contents/MacOS" / f"{parent.stem} Helper")
        if helper.is_file():
            return str(helper)
        binary = parent / "Contents/MacOS" / parent.stem
        return str(binary) if binary.is_file() else None
    return None
