from __future__ import annotations

import asyncio
import errno
import os
import stat


def _directory_state(path: str, previous_device: int | None) -> tuple[str, int | None]:
    try:
        info = os.stat(path)
        if previous_device is not None and info.st_dev != previous_device:
            return "unknown", previous_device
        return ("present" if stat.S_ISDIR(info.st_mode) else "missing"), info.st_dev
    except OSError as exc:
        if exc.errno not in {errno.ENOENT, errno.ENOTDIR}:
            return "unknown", previous_device
        # An unmounted volume exposes an underlying parent on a different
        # device. Keep its last valid state until the original device returns.
        parent = os.path.dirname(path)
        while parent:
            try:
                info = os.stat(parent)
                if previous_device is not None and info.st_dev != previous_device:
                    return "unknown", previous_device
                if previous_device is None and path.startswith(
                    ("/Volumes/", "/mnt/", "/media/", "\\\\")
                ):
                    return "unknown", None
                return "missing", previous_device
            except OSError as parent_error:
                if parent_error.errno not in {errno.ENOENT, errno.ENOTDIR}:
                    return "unknown", previous_device
            ancestor = os.path.dirname(parent)
            if ancestor == parent:
                break
            parent = ancestor
        return "unknown", previous_device


class DirectoryObserver:
    def __init__(self) -> None:
        self._semaphore = asyncio.Semaphore(8)
        self._devices: dict[str, int] = {}
        self._pending: dict[str, asyncio.Task[str]] = {}

    async def _stat(self, path: str) -> str:
        async with self._semaphore:
            result, device = await asyncio.to_thread(
                _directory_state, path, self._devices.get(path)
            )
            if result == "missing":
                await asyncio.sleep(0.2)
                result, device = await asyncio.to_thread(
                    _directory_state, path, self._devices.get(path)
                )
            if device is not None:
                self._devices[path] = device
            return result

    async def read(self, paths: set[str]) -> list[dict[str, str]]:
        self._devices = {
            p: d for p, d in self._devices.items() if p in paths or p in self._pending
        }

        async def observe(path: str) -> dict[str, str]:
            task = self._pending.get(path)
            if task is None:
                task = self._pending[path] = asyncio.create_task(self._stat(path))
            try:
                state = await asyncio.wait_for(asyncio.shield(task), timeout=5)
            except TimeoutError:
                state = "unknown"
            finally:
                if task.done():
                    self._pending.pop(path, None)
            return {"path": path, "state": state}

        return list(await asyncio.gather(*(observe(path) for path in sorted(paths))))
