from __future__ import annotations

import json
import os
import re
import sqlite3
import urllib.request
from pathlib import Path
from typing import Any

import psutil

from connector.logging import logger
from connector.runtimes.antigravity.provider_config import (
    DEFAULT_AGENTAPI_PATH,
    DEFAULT_ANTIGRAVITY_DIR,
    DEFAULT_DB_PATH,
)


def find_antigravity_ls() -> tuple[int | None, str | None, str | None]:
    """Discover running Antigravity language_server: (pid, csrf_token, ls_address)."""
    for p in psutil.process_iter(["pid", "name", "cmdline"]):
        try:
            cmd = " ".join(p.info.get("cmdline") or [])
            if "language_server" in cmd and "antigravity" in cmd:
                pid = p.info["pid"]
                csrf = None
                m = re.search(r"--csrf_token\s+([^\s]+)", cmd)
                if m:
                    csrf = m.group(1)

                listening_ports: list[int] = []
                for c in p.net_connections(kind="tcp"):
                    if c.status == psutil.CONN_LISTEN:
                        listening_ports.append(c.laddr.port)

                # Test which port is the Antigravity language server HTTP/gRPC server
                for port in listening_ports:
                    try:
                        req = urllib.request.Request(f"http://127.0.0.1:{port}/")
                        with urllib.request.urlopen(req, timeout=0.5) as res:
                            if res.status == 200:
                                body = res.read().decode("utf-8", errors="replace")
                                if "antigravity" in body.lower():
                                    if not csrf:
                                        cm = re.search(r'"csrfToken":"([^"]+)"', body)
                                        if cm:
                                            csrf = cm.group(1)
                                    return pid, csrf, f"127.0.0.1:{port}"
                    except Exception:
                        continue
        except Exception:
            continue
    return None, None, None


def find_antigravity_project_id(
    cwd: str | None = None, conversation_id: str | None = None
) -> tuple[str | None, str | None]:
    """Find active project_id and project_dir from database or environment.

    Returns (project_id, project_dir)
    """
    env_proj = os.environ.get("ANTIGRAVITY_PROJECT_ID")

    if DEFAULT_DB_PATH.exists():
        try:
            con = sqlite3.connect(f"file:{DEFAULT_DB_PATH}?mode=ro", uri=True)
            if conversation_id:
                row = con.execute(
                    "SELECT project_id, workspace_uris FROM conversation_summaries WHERE conversation_id = ?",
                    (conversation_id,),
                ).fetchone()
                if row and row[0] and row[0] != "outside-of-project":
                    con.close()
                    pdir = None
                    if row[1]:
                        try:
                            uris = json.loads(row[1])
                            if uris and isinstance(uris, list) and uris[0].startswith("file://"):
                                pdir = uris[0][7:]
                        except Exception:
                            pass
                    return env_proj or row[0], pdir

            if cwd:
                target_uri = f"file://{Path(cwd).resolve()}"
                row = con.execute(
                    "SELECT project_id, workspace_uris FROM conversation_summaries WHERE workspace_uris LIKE ? AND project_id != '' AND project_id != 'outside-of-project' ORDER BY last_modified_time DESC LIMIT 1",
                    (f"%{target_uri}%",),
                ).fetchone()
                if row and row[0]:
                    con.close()
                    pdir = None
                    if row[1]:
                        try:
                            uris = json.loads(row[1])
                            if uris and isinstance(uris, list) and uris[0].startswith("file://"):
                                pdir = uris[0][7:]
                        except Exception:
                            pass
                    return env_proj or row[0], pdir or str(Path(cwd).resolve())

            row = con.execute(
                "SELECT project_id, workspace_uris FROM conversation_summaries WHERE project_id != '' AND project_id != 'outside-of-project' ORDER BY last_modified_time DESC LIMIT 1"
            ).fetchone()
            con.close()
            if row and row[0]:
                pdir = None
                if row[1]:
                    try:
                        uris = json.loads(row[1])
                        if uris and isinstance(uris, list) and uris[0].startswith("file://"):
                            pdir = uris[0][7:]
                    except Exception:
                        pass
                return env_proj or row[0], pdir
        except Exception as e:
            logger.warning(f"[Antigravity] Failed to query project_id from db: {e}")

    return env_proj, None


def get_antigravity_env(
    cwd: str | None = None, conversation_id: str | None = None
) -> tuple[dict[str, str], str | None]:
    """Construct environment dictionary required by agentapi and return (env, working_dir)."""
    env = os.environ.copy()
    pid, csrf, ls_addr = find_antigravity_ls()
    if ls_addr:
        env["ANTIGRAVITY_LS_ADDRESS"] = ls_addr
    if csrf:
        env["ANTIGRAVITY_CSRF_TOKEN"] = csrf
    project_id, project_dir = find_antigravity_project_id(cwd, conversation_id)
    if project_id:
        env["ANTIGRAVITY_PROJECT_ID"] = project_id
    env["no_proxy"] = "127.0.0.1,localhost"
    env["NO_PROXY"] = "127.0.0.1,localhost"
    effective_cwd = cwd or project_dir
    return env, effective_cwd


def check_antigravity_installed() -> dict[str, Any]:
    """Check local installation and running status."""
    agentapi_exists = DEFAULT_AGENTAPI_PATH.exists()
    db_exists = DEFAULT_DB_PATH.exists()
    pid, csrf, ls_addr = find_antigravity_ls()
    is_running = pid is not None and ls_addr is not None

    return {
        "installed": agentapi_exists and db_exists,
        "running": is_running,
        "pid": pid,
        "ls_address": ls_addr,
        "agentapi_path": str(DEFAULT_AGENTAPI_PATH),
        "db_path": str(DEFAULT_DB_PATH),
    }
