"""Offline native Pi RPC smoke probe, with an empty agent directory and no prompt.

Run from the connector project: uv run python scripts/probe_pi.py
This does not start an AA Connector or connect to an AA server.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import subprocess
import tempfile
from pathlib import Path

from connector.runtimes.pi.launcher import resolve_pi_command
from connector.runtimes.pi.permissions import APPROVAL_EXTENSION_PATH
from connector.runtimes.pi.rpc import PiRpcProcess


async def probe() -> dict[str, object]:
    report: dict[str, object] = {"pi_resolved": False, "rpc_ok": False, "child_stopped": False}
    command = resolve_pi_command("pi")
    if command is None:
        return report
    report["pi_resolved"] = True
    original_env = dict(os.environ)
    original_logging_threshold = logging.root.manager.disable
    keep = {"path", "pathext", "systemroot", "windir", "comspec", "temp", "tmp", "lang"}
    # PiRpcProcess normally merges overrides into its parent's environment. The
    # standalone probe removes credentials before that merge and restores on exit.
    with tempfile.TemporaryDirectory(prefix="aa-pi-native-probe-") as directory:
        env = {key: value for key, value in original_env.items() if key.lower() in keep}
        env.update(HOME=directory, USERPROFILE=directory, APPDATA=directory,
                   LOCALAPPDATA=directory, PI_CODING_AGENT_DIR=str(Path(directory) / "agent"),
                   PI_OFFLINE="1", NO_COLOR="1")
        os.environ.clear()
        os.environ.update(env)
        logging.disable(logging.CRITICAL)
        rpc: PiRpcProcess | None = None
        try:
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
            version = await asyncio.to_thread(subprocess.run, [*command, "--version"],
                                             capture_output=True, timeout=20, cwd=directory,
                                             stdin=subprocess.DEVNULL, creationflags=flags)
            raw = version.stdout.decode("utf-8", "replace").strip()
            report["pi_version"] = raw if re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][\w.]+)?", raw) else "unrecognized"
            help_result = await asyncio.to_thread(subprocess.run, [*command, "--no-extensions", "--help"],
                                                 capture_output=True, timeout=20, cwd=directory,
                                                 stdin=subprocess.DEVNULL, creationflags=flags)
            help_text = help_result.stdout.decode("utf-8", "replace")
            report["required_cli_flags_present"] = all(flag in help_text for flag in (
                "--mode", "--no-session", "--session-dir", "--extension"))
            # Pi 0.87 has no --no-mcp switch. --no-extensions already disables
            # discovered/builtin extensions; keep all other isolation controls.
            mcp_flags = ["--no-mcp"] if "--no-mcp" in help_text else []
            rpc = PiRpcProcess([*command, "--mode", "rpc", "--no-session", "--no-extensions",
                                "--no-skills", "--no-prompt-templates", "--no-tools", "--no-context-files",
                                *mcp_flags, "--offline", "--extension", str(APPROVAL_EXTENSION_PATH)],
                               cwd=directory, env=env, request_timeout=20)
            await rpc.start()
            response = await rpc.request({"type": "get_state"})
            report["rpc_ok"] = response.get("success") is True
            report["approval_extension_present"] = APPROVAL_EXTENSION_PATH.is_file()
        except Exception as exc:  # noqa: BLE001 - report classification, never private diagnostics
            report["error_category"] = type(exc).__name__
        finally:
            if rpc is not None:
                try:
                    await rpc.close(timeout=3)
                    report["child_stopped"] = rpc.returncode is not None
                except Exception as exc:  # noqa: BLE001 - bounded cleanup report
                    report["cleanup_error_category"] = type(exc).__name__
            os.environ.clear()
            os.environ.update(original_env)
            logging.disable(original_logging_threshold)
    return report


if __name__ == "__main__":
    result = asyncio.run(probe())
    print(json.dumps(result, ensure_ascii=True))
    raise SystemExit(0 if result["rpc_ok"] and result["child_stopped"] else 1)
