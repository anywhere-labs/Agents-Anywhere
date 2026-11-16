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
import time
import zipfile
from collections.abc import Callable
from contextlib import contextmanager
from pathlib import Path
from typing import TextIO

import httpx

from ..domain.definitions import AcpError

NODE_VERSION = "22.23.2"
# The Pi packages declare engines ">=22.19.0"; newer majors are accepted.
MINIMUM_NODE = (22, 19, 0)
# Desktop passes its own Electron executable, which runs as Node when told to.
ELECTRON_NODE_ENV = "AA_ELECTRON_NODE"
ELECTRON_RESET = Path(__file__).with_name("electron-node.mjs").resolve()
# A configured source is tried first, then the official one, then npmmirror
# (whose Node checksums match the official release). Each source supplies its
# own checksum list, like the PyPI mirrors Desktop already offers.
NODE_MIRROR_ENV = "AA_NODE_MIRROR"
NODE_DIST_SOURCES = ("https://nodejs.org/dist", "https://registry.npmmirror.com/-/binary/node")
NPM_REGISTRY_ENV = "AA_NPM_REGISTRY"
NPM_REGISTRY_SOURCES = ("https://registry.npmjs.org", "https://registry.npmmirror.com")


# Another Desktop launch, a Pi session or an orphaned preflight may still be
# downloading; wait for it rather than failing, but never wait forever.
LOCK_TIMEOUT_SECONDS = 600.0
_LOCK_POLL_SECONDS = 0.5


@contextmanager
def installation_lock(path: Path, *, timeout: float | None = None):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    deadline = time.monotonic() + (LOCK_TIMEOUT_SECONDS if timeout is None else timeout)
    with path.open("a+b") as handle:
        if sys.platform == "win32":
            import msvcrt
            handle.write(b"\0")
            handle.flush()

            def acquire() -> None:
                # LK_LOCK gives up after ten seconds with EDEADLK; poll instead.
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            def acquire() -> None:
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        while True:
            try:
                acquire()
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise AcpError("agent_install_busy", "另一个进程正在准备 Agent 运行环境，请稍后重试。") from None
                time.sleep(_LOCK_POLL_SECONDS)
        try:
            yield
        finally:
            if sys.platform == "win32":
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def _sources(variable: str, defaults: tuple[str, ...]) -> list[str]:
    configured = os.environ.get(variable, "").strip().rstrip("/")
    return list(dict.fromkeys(value for value in (configured, *defaults) if value))


def node_environment(node: Path) -> dict[str, str]:
    """Extra environment ``node`` needs: Desktop's Electron must be told to act as Node."""
    configured = os.environ.get(ELECTRON_NODE_ENV)
    if not configured:
        return {}
    try:
        same = Path(configured).resolve() == Path(node).resolve()
    except OSError:
        return {}
    return {"ELECTRON_RUN_AS_NODE": "1"} if same else {}


def node_launch_arguments(node: Path) -> list[str]:
    """Arguments before the script so Electron's flag does not leak into agent commands."""
    return ["--import", ELECTRON_RESET.as_uri()] if node_environment(node) else []


def _supported(executable: Path, env: dict[str, str] | None = None) -> bool:
    try:
        version = subprocess.check_output([str(executable), "--version"], timeout=10, text=True, encoding="utf-8", env=env, stderr=subprocess.DEVNULL)
        return tuple(int(value) for value in version.strip().lstrip("v").split(".")) >= MINIMUM_NODE
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


def _node_pair(executable: Path) -> tuple[Path, Path] | None:
    if not executable.is_file():
        return None
    try:
        # Preserve argv[0] until a version-manager shim resolves its active Node.
        resolved = subprocess.check_output([str(executable), "--print", "process.execPath"], timeout=10, text=True, encoding="utf-8", stderr=subprocess.DEVNULL).strip()
        if not Path(resolved).is_absolute():
            return None
        executable = Path(resolved)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    candidates = (
        executable.parent / "node_modules/npm/bin/npm-cli.js",
        executable.parent.parent / "lib/node_modules/npm/bin/npm-cli.js",
    )
    npm = next((path for path in candidates if path.is_file()), None)
    if not npm or not executable.is_file() or not _supported(executable):
        return None
    return executable.resolve(), npm.resolve()


def electron_node() -> Path | None:
    """Desktop's own executable, usable as Node without npm or a download."""
    configured = os.environ.get(ELECTRON_NODE_ENV)
    if not configured or not Path(configured).is_file():
        return None
    executable = Path(configured)
    if not _supported(executable, {**os.environ, "ELECTRON_RUN_AS_NODE": "1"}):
        return None
    return executable.resolve()


def extract_zip(archive: Path, destination: Path) -> None:
    """Reject members escaping ``destination``, even when it sits behind a link."""
    # Resolve the base too: a data directory behind a symlink or Windows
    # junction must compare like for like with the resolved member paths.
    base = destination.resolve()
    with zipfile.ZipFile(archive) as package:
        for member in package.namelist():
            if not (base / member).resolve().is_relative_to(base):
                raise AcpError("node_archive_invalid", "Node 安装包路径无效。")
        package.extractall(destination)


def _download_node(base: str, filename: str, archive: Path) -> None:
    """Fetch one release archive and its checksum from ``base``; raise on any failure."""
    with httpx.Client(timeout=120, follow_redirects=True) as client:
        sums = client.get(f"{base}/v{NODE_VERSION}/SHASUMS256.txt")
        sums.raise_for_status()
        expected = next((fields[0] for fields in map(str.split, sums.text.splitlines()) if fields and fields[-1] == filename), None)
        if not expected:
            raise AcpError("node_checksum_missing", "Node 发布包缺少校验记录。")
        digest = hashlib.sha256()
        size = 0
        with client.stream("GET", f"{base}/v{NODE_VERSION}/{filename}") as response:
            response.raise_for_status()
            with archive.open("wb") as output:
                for block in response.iter_bytes():
                    size += len(block)
                    if size > 128 * 1024 * 1024:
                        raise AcpError("node_archive_too_large", "Node 下载超过大小上限。")
                    digest.update(block)
                    output.write(block)
    if digest.hexdigest() != expected:
        raise AcpError("node_checksum_mismatch", "Node 下载校验失败，请重试。")


def node_runtime(root: Path, *, on_install: Callable[[], None] | None = None) -> tuple[Path, Path]:
    """A Node with npm: a compatible system install, else a verified download."""
    system = shutil.which("node")
    if system and (pair := _node_pair(Path(system))):
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
    if on_install:
        on_install()
    filename = name + (".zip" if target == "win" else ".tar.gz")
    with tempfile.TemporaryDirectory(prefix=".node-", dir=root) as temporary:
        staging = Path(temporary)
        archive = staging / filename
        failure: AcpError | None = None
        for base in _sources(NODE_MIRROR_ENV, NODE_DIST_SOURCES):
            try:
                _download_node(base, filename, archive)
                break
            except httpx.HTTPError as error:
                failure = AcpError("node_download_failed", "Node 下载失败，请检查网络后重试。")
                failure.__cause__ = error
            except AcpError as error:
                failure = error
            archive.unlink(missing_ok=True)
        else:
            raise failure or AcpError("node_download_failed", "Node 下载失败，请检查网络后重试。")
        if target == "win":
            extract_zip(archive, staging)
        else:
            with tarfile.open(archive) as package:
                package.extractall(staging, filter="data")
        if not _node_pair(staging / name / ("node.exe" if target == "win" else "bin/node")):
            raise AcpError("node_install_invalid", "Node 运行环境校验失败。")
        if destination.exists():
            shutil.rmtree(destination)
        (staging / name).rename(destination)
    return _node_pair(executable)


def node_executable(root: Path, *, on_install: Callable[[], None] | None = None) -> Path:
    """A Node to run installed packages with; npm is not needed for that."""
    system = shutil.which("node")
    if system and (pair := _node_pair(Path(system))):
        return pair[0]
    return electron_node() or node_runtime(root, on_install=on_install)[0]


def _bundle_matches(bundle: Path | None, dependencies: dict[str, str], entry: str) -> bool:
    if bundle is None:
        return False
    try:
        manifest = json.loads((bundle / "package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    return manifest.get("dependencies") == dependencies and (bundle / "node_modules" / entry).is_file()


def _npm_install(root: Path, staging: Path, entry: str, output: TextIO | None) -> None:
    node, npm = node_runtime(root)
    env = {key: value for key, value in os.environ.items() if key not in {"NODE_OPTIONS", "NODE_PATH"}}
    env["PATH"] = str(node.parent) + os.pathsep + env.get("PATH", "")
    stream = output if output is not None else subprocess.DEVNULL
    for registry in _sources(NPM_REGISTRY_ENV, NPM_REGISTRY_SOURCES):
        shutil.rmtree(staging / "node_modules", ignore_errors=True)
        try:
            result = subprocess.run([str(node), str(npm), "install", f"--registry={registry}/", "--omit=dev", "--ignore-scripts", "--package-lock=false", "--no-audit", "--no-fund"], cwd=staging, env=env, stdout=stream, stderr=stream, timeout=300, check=False)
        except subprocess.TimeoutExpired:
            continue
        if not result.returncode and (staging / "node_modules" / entry).is_file():
            return
    raise AcpError("agent_install_failed", "Agent 运行环境安装失败，请检查网络后重试。")


def install_npm_runtime(root: Path, dependencies: dict[str, str], entry: str, *, output: TextIO | None = None, on_install: Callable[[], None] | None = None, bundle: Path | None = None) -> tuple[Path, Path]:
    """Seed from a bundled install of the same dependencies, else use npm's registry integrity checks."""
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    identity = hashlib.sha256(json.dumps(dependencies, sort_keys=True).encode()).hexdigest()[:20]
    with installation_lock(root / ".install.lock"):
        destination = root / identity
        script = destination / "node_modules" / entry
        if not (script.is_file() and (destination / ".ready").is_file()):
            if on_install:
                on_install()
            with tempfile.TemporaryDirectory(prefix=".npm-", dir=root) as temporary:
                staging = Path(temporary) / "runtime"
                staging.mkdir(mode=0o700)
                (staging / "package.json").write_text(json.dumps({"private": True, "dependencies": dependencies}))
                if _bundle_matches(bundle, dependencies, entry):
                    # A copy, not a link: a Desktop update replaces its resources
                    # while Pi instances keep running from this cache.
                    shutil.copytree(bundle / "node_modules", staging / "node_modules", symlinks=True)
                else:
                    _npm_install(root, staging, entry, output)
                (staging / ".ready").write_text(identity)
                if destination.exists():
                    shutil.rmtree(destination)
                staging.rename(destination)
        return node_executable(root, on_install=on_install), script
