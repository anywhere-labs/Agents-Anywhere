"""Finds a local Hermes and confirms that its ACP entry point can load."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

from ...domain.definitions import AcpError, LaunchDefinition

CHECK_SECONDS = 60
# Same boundary as AgentProcess: AA's own credentials never reach the Agent.
PRIVATE_PREFIXES = ("AGENT_", "AGENTS_ANYWHERE", "AA_", "NODE_OPTIONS", "NODE_INSPECT", "ELECTRON_")


def candidates() -> list[Path]:
    """Connectors started by Desktop or a service often miss the login shell PATH."""
    found = shutil.which("hermes")
    home = Path.home()
    return [
        *([Path(found)] if found else []),
        home / ".local" / "bin" / "hermes",
        home / ".hermes" / "hermes-agent" / "venv" / "bin" / "hermes",
    ]


def resolve_executable(values: dict) -> Path:
    explicit = values.get("cliPath")
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_absolute() or not path.is_file():
            raise AcpError("hermes_cli_missing", f"未找到指定的 hermes：{explicit}")
    else:
        path = next((item for item in candidates() if item.is_file()), None)
        if path is None:
            raise AcpError(
                "hermes_cli_missing",
                "未找到本机 hermes。请先安装 Hermes Agent，或在实例配置中填写 hermes 路径。",
            )
    if sys.platform == "win32" and path.suffix.lower() in {".cmd", ".bat"}:
        raise AcpError(
            "hermes_cli_unsupported",
            "无法直接启动 Hermes 的批处理入口，请填写虚拟环境中的 hermes.exe 路径。",
        )
    return path


def launch_environment(values: dict) -> tuple[tuple[str, str], ...]:
    home = values.get("hermesHome")
    return (("HERMES_HOME", str(Path(home).expanduser())),) if home else ()


def run_acp(path: Path, flag: str, environment: tuple[tuple[str, str], ...]) -> str:
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.upper().startswith(PRIVATE_PREFIXES)
    }
    env.update(dict(environment))
    try:
        result = subprocess.run(
            [str(path), "acp", flag],
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
            "hermes_acp_unavailable", f"无法运行 hermes acp {flag}，请确认 Hermes 安装完整。"
        ) from error
    if result.returncode != 0:
        raise AcpError(
            "hermes_acp_unavailable",
            "Hermes 的 ACP 入口不可用，请确认已安装 ACP 依赖（acp extra），并能运行 hermes acp --check。",
        )
    return result.stdout.strip()


def prepare_launch(values: dict) -> LaunchDefinition:
    """Runs before any Agent process, so failures here are definite."""
    path = resolve_executable(values)
    environment = launch_environment(values)
    run_acp(path, "--check", environment)
    version = run_acp(path, "--version", environment).splitlines()
    return LaunchDefinition(
        str(path),
        ("acp",),
        "hermes-" + (version[-1] if version else "unknown"),
        environment=environment,
    )
