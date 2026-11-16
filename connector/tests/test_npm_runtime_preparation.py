"""Shared Node/npm preparation must not wedge Desktop startup (#654)."""
from __future__ import annotations

import sys
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
