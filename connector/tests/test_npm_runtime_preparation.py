"""Shared Node/npm preparation must not wedge Desktop startup (#654)."""
from __future__ import annotations

import hashlib
import json
import sys
import tarfile
import threading
import time
import zipfile
from pathlib import Path

import httpx
import pytest

from connector.runtimes.acp.domain.definitions import AcpError
from connector.runtimes.acp.infrastructure import npm


def _hold(path: Path):
    """Hold the lock from a separate handle, like another process would."""
    if sys.platform == "win32":
        import msvcrt
        handle = path.open("a+b")
        handle.write(b"\0")
        handle.flush()
        handle.seek(0)
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)

        def release() -> None:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            handle.close()
    else:
        import fcntl
        handle = path.open("a+b")
        fcntl.flock(handle, fcntl.LOCK_EX)

        def release() -> None:
            fcntl.flock(handle, fcntl.LOCK_UN)
            handle.close()
    return release


def test_busy_lock_reports_a_stable_code_instead_of_an_os_error(tmp_path: Path) -> None:
    lock = tmp_path / ".install.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    release = _hold(lock)
    try:
        with pytest.raises(AcpError) as raised, npm.installation_lock(lock, timeout=0.2):
            pytest.fail("lock must not be granted while another holder has it")
        assert raised.value.code == "agent_install_busy"
    finally:
        release()


def test_lock_waits_for_the_other_holder_instead_of_failing(tmp_path: Path) -> None:
    lock = tmp_path / ".install.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    release = _hold(lock)
    timer = threading.Timer(0.6, release)
    timer.start()
    started = time.monotonic()
    try:
        with npm.installation_lock(lock, timeout=10):
            waited = time.monotonic() - started
    finally:
        timer.join()
    assert waited >= 0.5


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell fixture")
@pytest.mark.parametrize(("version", "accepted"), [("v22.19.0", True), ("v24.17.0", True), ("v22.18.1", False), ("v20.19.0", False)])
def test_system_node_accepts_every_version_the_pi_packages_support(tmp_path: Path, version: str, accepted: bool) -> None:
    node = tmp_path / "bin" / "node"
    node.parent.mkdir()
    node.write_text(f'#!/bin/sh\nif [ "$1" = "--version" ]; then echo {version}; else echo "{node}"; fi\n')
    node.chmod(0o755)
    cli = tmp_path / "lib/node_modules/npm/bin/npm-cli.js"
    cli.parent.mkdir(parents=True)
    cli.write_text("")
    pair = npm._node_pair(node)
    assert (pair is not None) is accepted
    if pair:
        assert pair == (node.resolve(), cli.resolve())


@pytest.mark.skipif(sys.platform == "win32", reason="symlink creation needs privileges on Windows")
def test_zip_extraction_accepts_a_data_directory_behind_a_link(tmp_path: Path) -> None:
    real = tmp_path / "real"
    real.mkdir()
    linked = tmp_path / "linked"
    linked.symlink_to(real, target_is_directory=True)
    archive = tmp_path / "node.zip"
    with zipfile.ZipFile(archive, "w") as package:
        package.writestr("node-v22.23.2-win-x64/node.exe", "binary")
    npm.extract_zip(archive, linked)
    assert (real / "node-v22.23.2-win-x64/node.exe").read_text() == "binary"


def test_zip_extraction_still_rejects_escaping_members(tmp_path: Path) -> None:
    archive = tmp_path / "node.zip"
    with zipfile.ZipFile(archive, "w") as package:
        package.writestr("../escape.txt", "x")
    destination = tmp_path / "staging"
    destination.mkdir()
    with pytest.raises(AcpError) as raised:
        npm.extract_zip(archive, destination)
    assert raised.value.code == "node_archive_invalid"
    assert not (tmp_path / "escape.txt").exists()


def test_node_download_errors_have_their_own_code(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(npm.shutil, "which", lambda _name: None)
    monkeypatch.setattr(npm.sys, "platform", "linux")
    monkeypatch.setattr(npm.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(npm.platform, "libc_ver", lambda: ("glibc", "2.39"))

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection reset", request=request)

    real_client = httpx.Client
    monkeypatch.setattr(npm.httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(unreachable), **kwargs))
    with pytest.raises(AcpError) as raised:
        npm.node_runtime(tmp_path)
    assert raised.value.code == "node_download_failed"


ENTRY = "pkg/entry.js"
DEPENDENCIES = {"pkg": "1.0.0"}


def _script(path: Path, body: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)
    return path


def _fake_electron(tmp_path: Path, version: str = "v24.22.3") -> Path:
    # Answers like Node only when told to run as Node, like Electron does.
    return _script(tmp_path / "Electron", f'if [ "$ELECTRON_RUN_AS_NODE" = 1 ] && [ "$1" = "--version" ]; then echo {version}; else exit 3; fi\n')


def _bundle(tmp_path: Path, dependencies: dict[str, str]) -> Path:
    bundle = tmp_path / "bundle"
    (bundle / "node_modules/pkg").mkdir(parents=True)
    (bundle / "node_modules" / ENTRY).write_text("console.log('ok')")
    (bundle / "package.json").write_text(json.dumps({"private": True, "dependencies": dependencies}))
    return bundle


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell fixture")
def test_bundled_runtime_seeds_the_cache_and_runs_on_desktop_electron_without_network(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    electron = _fake_electron(tmp_path)
    monkeypatch.setenv(npm.ELECTRON_NODE_ENV, str(electron))
    monkeypatch.setattr(npm.shutil, "which", lambda _name: None)
    monkeypatch.setattr(npm, "node_runtime", lambda *_args, **_kwargs: pytest.fail("no Node or npm download with a matching bundle"))
    node, script = npm.install_npm_runtime(tmp_path / "root", DEPENDENCIES, ENTRY, bundle=_bundle(tmp_path, DEPENDENCIES))
    assert node == electron.resolve()
    assert script.read_text() == "console.log('ok')"
    assert (script.parents[2] / ".ready").is_file()
    assert npm.node_environment(node) == {"ELECTRON_RUN_AS_NODE": "1"}
    assert npm.node_launch_arguments(node) == ["--import", npm.ELECTRON_RESET.as_uri()]
    assert npm.ELECTRON_RESET.is_file()
    # A real Node needs neither the flag nor the reset hook.
    assert npm.node_environment(tmp_path / "node") == {}
    assert npm.node_launch_arguments(tmp_path / "node") == []


def test_bundle_for_other_dependencies_is_not_used(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[Path] = []

    def install(_root: Path, staging: Path, entry: str, _output: object) -> None:
        calls.append(staging)
        (staging / "node_modules" / entry).parent.mkdir(parents=True)
        (staging / "node_modules" / entry).write_text("from npm")

    monkeypatch.setattr(npm, "_npm_install", install)
    monkeypatch.setattr(npm, "node_executable", lambda *_args, **_kwargs: tmp_path / "node")
    _node, script = npm.install_npm_runtime(tmp_path / "root", DEPENDENCIES, ENTRY, bundle=_bundle(tmp_path, {"pkg": "2.0.0"}))
    assert len(calls) == 1
    assert script.read_text() == "from npm"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell fixture")
def test_electron_older_than_the_pi_minimum_is_not_used(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(npm.ELECTRON_NODE_ENV, str(_fake_electron(tmp_path, "v22.18.0")))
    assert npm.electron_node() is None


def _node_release(tmp_path: Path) -> tuple[bytes, str]:
    name = f"node-v{npm.NODE_VERSION}-linux-x64"
    source = tmp_path / "release" / name
    _script(source / "bin/node", f'if [ "$1" = "--version" ]; then echo v{npm.NODE_VERSION}; else echo "$0"; fi\n')
    (source / "lib/node_modules/npm/bin").mkdir(parents=True)
    (source / "lib/node_modules/npm/bin/npm-cli.js").write_text("")
    archive = tmp_path / f"{name}.tar.gz"
    with tarfile.open(archive, "w:gz") as package:
        package.add(source, arcname=name)
    data = archive.read_bytes()
    return data, f"{hashlib.sha256(data).hexdigest()}  {name}.tar.gz\n"


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell fixture")
@pytest.mark.parametrize(("configured", "expected_hosts"), [
    (None, ["nodejs.org", "registry.npmmirror.com"]),
    ("https://mirror.example/node/", ["mirror.example"]),
])
def test_node_download_tries_the_configured_source_then_official_then_npmmirror(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, configured: str | None, expected_hosts: list[str]) -> None:
    data, sums = _node_release(tmp_path)
    monkeypatch.setattr(npm.shutil, "which", lambda _name: None)
    monkeypatch.setattr(npm.sys, "platform", "linux")
    monkeypatch.setattr(npm.platform, "machine", lambda: "x86_64")
    monkeypatch.setattr(npm.platform, "libc_ver", lambda: ("glibc", "2.39"))
    if configured:
        monkeypatch.setenv(npm.NODE_MIRROR_ENV, configured)
    else:
        monkeypatch.delenv(npm.NODE_MIRROR_ENV, raising=False)
    hosts: list[str] = []

    def serve(request: httpx.Request) -> httpx.Response:
        hosts.append(request.url.host)
        if request.url.host == "nodejs.org":
            raise httpx.ConnectError("too slow", request=request)
        return httpx.Response(200, text=sums) if request.url.path.endswith("SHASUMS256.txt") else httpx.Response(200, content=data)

    real_client = httpx.Client
    monkeypatch.setattr(npm.httpx, "Client", lambda **kwargs: real_client(transport=httpx.MockTransport(serve), **kwargs))
    (tmp_path / "root").mkdir()
    node, cli = npm.node_runtime(tmp_path / "root")
    assert node.name == "node" and cli.name == "npm-cli.js"
    assert list(dict.fromkeys(hosts)) == expected_hosts


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX shell fixture")
@pytest.mark.parametrize(("configured", "expected"), [
    (None, ["https://registry.npmjs.org/", "https://registry.npmmirror.com/"]),
    ("https://registry.npmmirror.com", ["https://registry.npmmirror.com/"]),
])
def test_npm_install_falls_back_to_npmmirror(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, configured: str | None, expected: list[str]) -> None:
    log = tmp_path / "registries"
    # Only npmmirror answers; the npm "invocation" is node <npm-cli.js> install ...
    node = _script(tmp_path / "system/bin/node", f"""case "$1" in
  --version) echo v22.23.2 ;;
  --print) echo "$0" ;;
  *) for arg in "$@"; do case "$arg" in --registry=*) registry="${{arg#--registry=}}" ;; esac; done
     echo "$registry" >> "{log}"
     case "$registry" in *npmmirror*) mkdir -p node_modules/pkg && echo installed > node_modules/{ENTRY} ;; *) exit 1 ;; esac ;;
esac
""")
    (tmp_path / "system/lib/node_modules/npm/bin").mkdir(parents=True)
    (tmp_path / "system/lib/node_modules/npm/bin/npm-cli.js").write_text("")
    monkeypatch.setattr(npm.shutil, "which", lambda _name: str(node))
    if configured:
        monkeypatch.setenv(npm.NPM_REGISTRY_ENV, configured)
    else:
        monkeypatch.delenv(npm.NPM_REGISTRY_ENV, raising=False)
    found, script = npm.install_npm_runtime(tmp_path / "root", DEPENDENCIES, ENTRY)
    assert found == node.resolve()
    assert script.read_text().strip() == "installed"
    assert log.read_text().split() == expected
