"""Exercise native process-tree cleanup and parent-death handling."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import psutil

from connector.runtimes.acp.domain.definitions import LaunchDefinition
from connector.runtimes.acp.infrastructure.processes import AgentProcess


def process_alive(pid):
    try:
        return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
    except psutil.NoSuchProcess:
        # A child can disappear between opening the PID and reading its status.
        return False


async def gone(pids):
    async with asyncio.timeout(8):
        while any(process_alive(pid) for pid in pids):
            await asyncio.sleep(0.05)


async def main():
    with tempfile.TemporaryDirectory(prefix="aa-acp-processes-") as directory:
        root = Path(directory)
        marker = root / "child.json"
        child = root / "child.py"
        child.write_text(
            "import json,os,subprocess,sys,time\nfrom pathlib import Path\np=subprocess.Popen([sys.executable,'-c','import time; time.sleep(120)'])\nPath(sys.argv[1]).write_text(json.dumps([os.getpid(),p.pid]))\ntime.sleep(120)\n"
        )
        owner = AgentProcess()
        try:
            await owner.start(
                LaunchDefinition(
                    sys.executable, (str(child), str(marker)), "controlled"
                ),
                str(root),
            )
            async with asyncio.timeout(8):
                while not marker.exists():
                    await asyncio.sleep(0.05)
            pids = json.loads(marker.read_text())
            await owner.close()
            await gone(pids)
        finally:
            await owner.close()
        marker.unlink()
        conductor = root / "owner.py"
        conductor.write_text(
            "import asyncio,sys\nfrom connector.runtimes.acp.domain.definitions import LaunchDefinition\nfrom connector.runtimes.acp.infrastructure.processes import AgentProcess\nasync def main():\n p=AgentProcess()\n await p.start(LaunchDefinition(sys.executable,(sys.argv[1],sys.argv[2]),'controlled'),sys.argv[3])\n await asyncio.sleep(120)\nasyncio.run(main())\n"
        )
        parent = await asyncio.create_subprocess_exec(
            sys.executable,
            str(conductor),
            str(child),
            str(marker),
            str(root),
            env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1])},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            async with asyncio.timeout(8):
                while not marker.exists():
                    await asyncio.sleep(0.05)
            pids = json.loads(marker.read_text())
            parent.kill()
            await parent.wait()
            await gone(pids)
        finally:
            if parent.returncode is None:
                parent.kill()
                await parent.wait()
        print(
            f"ACP {sys.platform}: child-tree teardown and owner-process death cleanup passed"
        )


if __name__ == "__main__":
    asyncio.run(main())
