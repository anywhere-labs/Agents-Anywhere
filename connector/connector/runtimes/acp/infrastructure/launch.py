"""Finds a definition's local executable and confirms its ACP entry point before launch."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

from ..domain.agents import AcpAgentDefinition
from ..domain.definitions import AcpError, LaunchDefinition

CHECK_SECONDS = 60
# Same boundary as AgentProcess: AA's own credentials never reach the Agent.
PRIVATE_PREFIXES = ("AGENT_", "AGENTS_ANYWHERE", "AA_", "NODE_OPTIONS", "NODE_INSPECT", "ELECTRON_")


def candidates(definition: AcpAgentDefinition) -> list[Path]:
    """Connectors started by Desktop or a service often miss the login shell PATH."""
    executable = definition.executable
    found = shutil.which(executable.name)
    windows_npm_bin = os.environ.get("APPDATA") if sys.platform == "win32" else None
    return [
        *([Path(found)] if found else []),
        *(Path(os.path.expandvars(item)).expanduser() for item in executable.candidates),
        *(
            [Path(windows_npm_bin) / "npm" / f"{executable.name}.cmd"]
            if windows_npm_bin and executable.windows_npm_entry
            else []
        ),
    ]


def resolve_executable(definition: AcpAgentDefinition, values: dict) -> Path:
    name = definition.executable.name
    explicit = values.get("cliPath")
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_absolute() or not path.is_file():
            raise AcpError("agent_cli_missing", f"未找到指定的 {name}：{explicit}")
    else:
        path = next((item for item in candidates(definition) if item.is_file()), None)
        if path is None:
            raise AcpError(
                "agent_cli_missing",
                f"未找到本机 {name}。请先安装 {definition.display_name}，或在实例配置中填写 {name} 路径。",
            )
    return path.absolute()


def launch_command(definition: AcpAgentDefinition, path: Path) -> tuple[str, ...]:
    if sys.platform != "win32" or path.suffix.lower() not in {".cmd", ".bat", ".ps1"}:
        return (str(path),)
    # Resolve known npm shims to fixed package entry points without a shell.
    npm_entry = definition.executable.windows_npm_entry
    if npm_entry:
        node = path.with_name("node.exe")
        if not node.is_file():
            found = shutil.which("node.exe")
            node = Path(found).absolute() if found else None
        entry = path.parent / "node_modules" / npm_entry
        if not entry.is_file():
            entry = path.parent.parent / npm_entry  # project-local node_modules/.bin
        if node is not None and entry.is_file():
            return (str(node), str(entry))
    name = definition.executable.name
    raise AcpError(
        "agent_cli_unsupported",
        f"无法直接启动 {name} 的批处理入口，请确认 Node.js 与 CLI 安装完整，或填写实际可执行文件的路径。",
    )


def launch_environment(definition: AcpAgentDefinition, values: dict) -> tuple[tuple[str, str], ...]:
    return tuple(
        (setting.environment, str(Path(values[setting.key]).expanduser()))
        for setting in definition.settings
        if values.get(setting.key)
    )


def run_check(
    definition: AcpAgentDefinition,
    command: tuple[str, ...],
    arguments: tuple[str, ...],
    environment: tuple[tuple[str, str], ...],
) -> str:
    name = Path(command[-1]).name
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.upper().startswith(PRIVATE_PREFIXES)
    }
    env.update(dict(environment))
    try:
        result = subprocess.run(
            [*command, *arguments],
            check=False,
            cwd=Path.home(),
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=CHECK_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise AcpError(
            "agent_acp_unavailable",
            f"无法运行 {name} {' '.join(arguments)}，请确认 {definition.display_name} 安装完整。",
        ) from error
    if result.returncode != 0:
        raise AcpError(
            "agent_acp_unavailable",
            f"{definition.display_name} 的 ACP 入口不可用，请确认能在本机运行 {name} {' '.join(arguments)}。",
        )
    return result.stdout.strip()


def local_launch(definition: AcpAgentDefinition, values: dict) -> LaunchDefinition:
    """Runs before any Agent process, so failures here are definite."""
    path = resolve_executable(definition, values)
    command = launch_command(definition, path)
    environment = launch_environment(definition, values)
    if definition.check:
        run_check(definition, command, definition.check, environment)
    version = (
        run_check(definition, command, definition.version, environment).splitlines()
        if definition.version
        else []
    )
    return LaunchDefinition(
        command[0],
        (*command[1:], *definition.arguments),
        f"{definition.runtime_type}-{version[-1] if version else 'unknown'}",
        environment=environment,
    )
