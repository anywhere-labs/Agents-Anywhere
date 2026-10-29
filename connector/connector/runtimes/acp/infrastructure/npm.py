"""Install published JavaScript runtimes without a global Node/npm installation."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from contextlib import contextmanager
from pathlib import Path

import httpx

from ..domain.definitions import AcpError

NODE_VERSION = "22.23.2"


@contextmanager
def installation_lock(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open("a+b") as handle:
        if sys.platform == "win32":
            import msvcrt
            handle.write(b"\0")
            handle.flush()
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX)
        try:
            yield
        finally:
            if sys.platform == "win32":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def _node_pair(executable: Path) -> tuple[Path, Path] | None:
    candidates = (
        executable.parent / "node_modules/npm/bin/npm-cli.js",
        executable.parent.parent / "lib/node_modules/npm/bin/npm-cli.js",
    )
    npm = next((path for path in candidates if path.is_file()), None)
    if not npm or not executable.is_file():
        return None
    try:
        version = subprocess.check_output([str(executable), "--version"], timeout=10, text=True)
        parts = tuple(int(value) for value in version.strip().lstrip("v").split("."))
        if (22, 19, 0) <= parts < (23, 0, 0):
            return executable.resolve(), npm.resolve()
    except (OSError, ValueError, subprocess.SubprocessError):
        pass
    return None


def node_runtime(root: Path) -> tuple[Path, Path]:
    system = shutil.which("node")
    if system and (pair := _node_pair(Path(system).resolve())):
        return pair
    machine = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine().lower())
    target = {"darwin": "darwin", "linux": "linux", "win32": "win"}.get(sys.platform)
    if not machine or not target:
        raise AcpError("node_platform_unsupported", "此设备平台暂不支持自动准备 Node。")
    if target == "linux" and platform.libc_ver()[0] != "glibc":
        raise AcpError("node_abi_unsupported", "自动安装的 Linux Node 运行环境需要 glibc。")
    name = f"node-v{NODE_VERSION}-{target}-{machine}"
    destination = root / name
    executable = destination / ("node.exe" if target == "win" else "bin/node")
    if pair := _node_pair(executable):
        return pair
    suffix = ".zip" if target == "win" else ".tar.gz"
    filename = name + suffix
    base = f"https://nodejs.org/dist/v{NODE_VERSION}/"
    with tempfile.TemporaryDirectory(prefix=".node-", dir=root) as temporary:
        staging = Path(temporary)
        archive = staging / filename
        with httpx.Client(timeout=120, follow_redirects=True) as client:
            sums = client.get(base + "SHASUMS256.txt")
            sums.raise_for_status()
            expected = next((line.split()[0] for line in sums.text.splitlines() if line.split()[-1] == filename), None)
            if not expected:
                raise AcpError("node_checksum_missing", "Node 发布包缺少校验记录。")
            digest = hashlib.sha256()
            size = 0
            with client.stream("GET", base + filename) as response:
                response.raise_for_status()
                with archive.open("xb") as output:
                    for block in response.iter_bytes():
                        size += len(block)
                        if size > 128 * 1024 * 1024:
                            raise AcpError("node_archive_too_large", "Node 下载超过大小上限。")
                        digest.update(block)
                        output.write(block)
        if digest.hexdigest() != expected:
            raise AcpError("node_checksum_mismatch", "Node 下载校验失败，请重试。")
        if target == "win":
            with zipfile.ZipFile(archive) as package:
                for member in package.namelist():
                    if not (staging / member).resolve().is_relative_to(staging):
                        raise AcpError("node_archive_invalid", "Node 安装包路径无效。")
                package.extractall(staging)
        else:
            with tarfile.open(archive) as package:
                package.extractall(staging, filter="data")
        if not _node_pair(staging / name / ("node.exe" if target == "win" else "bin/node")):
            raise AcpError("node_install_invalid", "Node 运行环境校验失败。")
        if destination.exists():
            shutil.rmtree(destination)
        (staging / name).rename(destination)
    return _node_pair(executable)


def install_npm_runtime(root: Path, dependencies: dict[str, str], entry: str) -> tuple[Path, Path]:
    """Use npm's registry integrity checks; never build application source here."""
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    identity = hashlib.sha256(json.dumps(dependencies, sort_keys=True).encode()).hexdigest()[:20]
    with installation_lock(root / ".install.lock"):
        node, npm = node_runtime(root)
        destination = root / identity
        script = destination / "node_modules" / entry
        if script.is_file() and (destination / ".ready").is_file():
            return node, script
        with tempfile.TemporaryDirectory(prefix=".npm-", dir=root) as temporary:
            staging = Path(temporary) / "runtime"
            staging.mkdir(mode=0o700)
            (staging / "package.json").write_text(json.dumps({"private": True, "dependencies": dependencies}))
            env = {key: value for key, value in os.environ.items() if key not in {"NODE_OPTIONS", "NODE_PATH"}}
            env["PATH"] = str(node.parent) + os.pathsep + env.get("PATH", "")
            result = subprocess.run([str(node), str(npm), "install", "--omit=dev", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund"], cwd=staging, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=300, check=False)
            if result.returncode or not (staging / "node_modules" / entry).is_file():
                raise AcpError("agent_install_failed", "Agent 运行环境安装失败，请检查网络后重试。")
            (staging / ".ready").write_text(identity)
            if destination.exists():
                shutil.rmtree(destination)
            staging.rename(destination)
        return node, script
