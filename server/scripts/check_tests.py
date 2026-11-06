"""Run isolated Server checks with an optional testmon selection shadow."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path

import asyncpg
from sqlalchemy.engine import make_url

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
SMOKE = [
    "tests/test_auth.py",
    "tests/test_protocol_contracts.py",
    "tests/test_architecture_boundaries.py",
    "tests/test_infrastructure_health.py",
]


def selection_reason(base: str | None) -> str | None:
    """Unknown inputs always select the full suite, never zero tests."""
    if not base:
        return "no base revision supplied"
    try:
        merge_base = subprocess.check_output(
            ["git", "merge-base", base, "HEAD"], cwd=REPO, text=True
        ).strip()
        changes = subprocess.check_output(
            ["git", "diff", "--name-status", "--no-renames", merge_base],
            cwd=REPO,
            text=True,
        ).splitlines()
        untracked = subprocess.check_output(
            [
                "git",
                "ls-files",
                "--others",
                "--exclude-standard",
                "server",
                "connector",
                "contracts",
            ],
            cwd=REPO,
            text=True,
        ).splitlines()
    except subprocess.CalledProcessError:
        return "base revision is unavailable"
    if untracked:
        return "untracked test inputs"
    for change in changes:
        status, path = change.split("\t", 1)
        if path.startswith(("connector/", "contracts/", ".github/")):
            return f"shared input changed: {path}"
        if not path.startswith("server/"):
            continue
        if (
            status != "M"
            or not path.endswith(".py")
            or path.startswith(
                (
                    "server/migrations/",
                    "server/scripts/",
                    "server/agent_server/infra/db/",
                )
            )
            or path
            in {
                "server/tests/conftest.py",
                "server/tests/runtime_fixtures.py",
                "server/tests/test_backend_mvp.py",
            }
        ):
            return f"untracked dependency category changed: {path}"
    if not (ROOT / ".testmondata").is_file():
        return "no dependency baseline (cold run)"
    return None


async def provision(base: str, names: list[str], *, drop: bool = False):
    url = make_url(base)
    if url.drivername not in {"postgresql", "postgresql+asyncpg"} or "test" not in (
        url.database or ""
    ):
        raise ValueError(
            "AGENT_SERVER_TEST_DB_URL must identify a disposable PostgreSQL test database"
        )
    conn = await asyncpg.connect(
        url.set(drivername="postgresql").render_as_string(hide_password=False)
    )
    try:
        for name in names:
            if drop:
                await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
            else:
                await conn.execute(f'CREATE DATABASE "{name}"')
    finally:
        await conn.close()


def run_stage(label, args, env, output, timeout):
    report = output / f"{label}.json"
    report.unlink(missing_ok=True)
    command = [
        sys.executable,
        "-m",
        "pytest",
        "-p",
        "scripts.test_probe",
        "-p",
        "no:cacheprovider",
        "-q",
        "--durations=10",
        "-o",
        "faulthandler_timeout=120",
        *args,
    ]
    start = time.monotonic()
    child = subprocess.Popen(
        command,
        cwd=ROOT,
        env={**env, "AA_CHECK_STAGE_REPORT": str(report)},
        start_new_session=os.name == "posix",
    )
    try:
        code = child.wait(timeout=timeout)
    except (subprocess.TimeoutExpired, KeyboardInterrupt) as exc:
        if os.name == "posix":
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
        else:
            subprocess.run(
                ["taskkill", "/PID", str(child.pid), "/T", "/F"], check=False
            )
        child.wait()
        if isinstance(exc, KeyboardInterrupt):
            raise
        code = 124
    result = (
        json.loads(report.read_text())
        if report.exists()
        else {"reports": [], "exit_code": code}
    )
    result.update(
        stage=label,
        wall_seconds=round(time.monotonic() - start, 3),
        exit_code=code,
        workers=int(args[args.index("-n") + 1]) if "-n" in args else 1,
    )
    print(f"\n{label}: {result['wall_seconds']}s, exit={code}", flush=True)
    report.write_text(json.dumps(result, indent=2))
    return result


def main():
    def interrupted(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--mode", choices=["full", "affected", "shadow", "verify"], default="verify"
    )
    parser.add_argument(
        "--base", help="PR base ref; missing/unsupported inputs fall back to full"
    )
    parser.add_argument("--workers", type=int, choices=range(1, 9), default=2)
    parser.add_argument(
        "--timeout", type=int, default=1200, help="per-stage timeout in seconds"
    )
    parser.add_argument("--output", type=Path, default=ROOT / ".test-results")
    options = parser.parse_args()
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    reason = (
        "full explicitly requested"
        if options.mode in {"full", "verify"}
        else selection_reason(options.base)
    )
    summary = {
        "mode": options.mode,
        "workers": options.workers,
        "fallback": reason,
        "stages": [],
    }
    (output / "summary.json").write_text(json.dumps(summary, indent=2))
    base = os.environ["AGENT_SERVER_TEST_DB_URL"]
    uid = secrets.token_hex(6)
    workers = ["master"] + [f"gw{i}" for i in range(options.workers)]
    names = [f"aa_check_test_{uid}_{worker}" for worker in workers]
    url = make_url(base)
    databases = {
        w: url.set(database=n).render_as_string(hide_password=False)
        for w, n in zip(workers, names)
    }
    env = {
        **os.environ,
        "AA_CHECK_DATABASES": json.dumps(databases),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    parallel = (
        ["-n", str(options.workers), "--dist", "worksteal"]
        if options.workers > 1
        else []
    )
    # Coverage collection adds CPU pressure; the cloud comparison showed a
    # timing-sensitive integration failure with four tracing workers. Keep
    # tracing at two, while uninstrumented full verification can use all workers.
    record_workers = min(options.workers, 2)
    record_parallel = (
        ["-n", str(record_workers), "--dist", "worksteal"] if record_workers > 1 else []
    )
    summary["record_workers"] = record_workers
    print(
        f"mode={options.mode}, workers={options.workers}, fallback={reason}", flush=True
    )
    try:
        asyncio.run(provision(base, names))
        if not reason:
            # Run mandatory checks separately: testmon selectors otherwise intersect,
            # rather than union, with explicit pytest file arguments.
            summary["stages"].append(
                run_stage(
                    "smoke", ["--no-testmon", *SMOKE], env, output, options.timeout
                )
            )
            summary["stages"].append(
                run_stage(
                    "affected",
                    ["--testmon", *record_parallel],
                    env,
                    output,
                    options.timeout,
                )
            )
        if reason or options.mode in {"full", "shadow", "verify"}:
            # Only cold/fallback runs need a complete dependency recording.
            # A warm shadow already updated the changed tests' dependencies.
            full_options = (
                ["--testmon", "--testmon-noselect"]
                if reason and options.mode != "verify"
                else ["--no-testmon"]
            )
            summary["stages"].append(
                run_stage(
                    "full",
                    [
                        *full_options,
                        *(record_parallel if "--testmon" in full_options else parallel),
                    ],
                    env,
                    output,
                    options.timeout,
                )
            )
        for stage in summary["stages"]:
            # pytest exit 5 is legitimate only for a warm, unchanged selection.
            if stage["exit_code"] and not (
                stage["stage"] == "affected" and stage["exit_code"] == 5
            ):
                return stage["exit_code"]
        return 0
    finally:
        summary["total_stage_seconds"] = round(
            sum(stage["wall_seconds"] for stage in summary["stages"]), 3
        )
        full = next((s for s in summary["stages"] if s["stage"] == "full"), None)
        affected = next(
            (s for s in summary["stages"] if s["stage"] == "affected"), None
        )
        if full and affected:
            selected = {
                r["id"]
                for s in summary["stages"]
                if s["stage"] != "full"
                for r in s["reports"]
            }
            summary["missed_failures"] = sorted(
                {r["id"] for r in full["reports"] if r["outcome"] == "failed"}
                - selected
            )
            fast_seconds = sum(
                s["wall_seconds"] for s in summary["stages"] if s["stage"] != "full"
            )
            summary["fast_seconds"] = round(fast_seconds, 3)
            summary["full_seconds"] = full["wall_seconds"]
            summary["time_reduction_percent"] = round(
                100 * (1 - fast_seconds / full["wall_seconds"]), 1
            )
        print(
            json.dumps({k: v for k, v in summary.items() if k != "stages"}), flush=True
        )
        try:
            asyncio.run(provision(base, names, drop=True))
        finally:
            (output / "summary.json").write_text(json.dumps(summary, indent=2))


if __name__ == "__main__":
    sys.exit(main())
