"""Compare worker/pool layouts using real broker CPU work, without opening ports.

This measures a CPU stage across independent worker-shaped Python processes.
It does not model Uvicorn connection placement, Redis or PostgreSQL throughput.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import multiprocessing
import os
import platform
import statistics
import sys
import time
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def child_cpu_sample():
    # Give simultaneous samples time to reach every already-warmed child.
    time.sleep(0.01)
    return os.getpid(), time.process_time()


async def child_cpu(executor, workers):
    samples = {}
    for _ in range(5):
        samples.update(
            await asyncio.gather(
                *(
                    asyncio.get_running_loop().run_in_executor(
                        executor, child_cpu_sample
                    )
                    for _ in range(workers * 2)
                )
            )
        )
        if len(samples) == workers:
            return samples
    raise AssertionError("could not sample every compute child")


def run_worker(connection, start, event_workers, batches):
    from agent_server.infra.timeline_broker import TimelineBroker

    from scripts.bench_session_pipeline import concurrent_fanout

    async def exercise():
        broker = TimelineBroker(event_workers=event_workers)
        await broker.start()
        try:
            await concurrent_fanout(broker)
            executor = broker._event_pool._executor if event_workers else None
            before = await child_cpu(executor, event_workers) if executor else {}
            connection.send({"ready": os.getpid(), "compute_pids": list(before)})
            assert await asyncio.to_thread(start.wait, 30)
            started, cpu, loop_cpu = (
                time.perf_counter(),
                time.process_time(),
                time.thread_time(),
            )
            for _ in range(batches):
                await concurrent_fanout(broker)
            completed = time.perf_counter()
            parent_cpu = time.process_time() - cpu
            loop_cpu = time.thread_time() - loop_cpu
            after = await child_cpu(executor, event_workers) if executor else {}
            return {
                "pid": os.getpid(),
                "compute_pids": list(after),
                "completed_at": completed,
                "worker_wall_s": completed - started,
                "parent_cpu_s": parent_cpu,
                "loop_cpu_s": loop_cpu,
                "compute_cpu_s": sum(after[pid] - before[pid] for pid in before),
                "notifications": batches * 24,
            }
        finally:
            await broker.close()

    try:
        connection.send(asyncio.run(exercise()))
    except BaseException:
        connection.send({"error": traceback.format_exc()})
        raise
    finally:
        connection.close()


def receive(connection):
    if not connection.poll(60):
        raise TimeoutError("benchmark worker did not respond")
    result = connection.recv()
    if "error" in result:
        raise RuntimeError(result["error"])
    return result


def measure_layout(workers, event_workers, total_batches):
    if total_batches % workers:
        raise ValueError("batches must be divisible by each worker count")
    context = multiprocessing.get_context("spawn")
    start = context.Event()
    processes, connections = [], []
    try:
        for _ in range(workers):
            parent, child = context.Pipe(duplex=False)
            process = context.Process(
                target=run_worker,
                args=(child, start, event_workers, total_batches // workers),
            )
            process.start()
            child.close()
            processes.append(process)
            connections.append(parent)
        ready = [receive(connection) for connection in connections]
        started = time.perf_counter()
        start.set()
        results = [receive(connection) for connection in connections]
        wall = max(result["completed_at"] for result in results) - started
        total_cpu = sum(
            result["parent_cpu_s"] + result["compute_cpu_s"] for result in results
        )
        notifications = sum(result["notifications"] for result in results)
        assert notifications == total_batches * 24
        return {
            "workers": workers,
            "event_workers_per_worker": event_workers,
            "compute_processes": workers * event_workers,
            "notifications": notifications,
            "delivered_events": notifications * 4,
            "wall_s": round(wall, 4),
            "notifications_per_second": round(notifications / wall, 1),
            "average_active_cores": round(total_cpu / wall, 3),
            "parent_cpu_s": round(sum(result["parent_cpu_s"] for result in results), 4),
            "compute_cpu_s": round(
                sum(result["compute_cpu_s"] for result in results), 4
            ),
            "worker_pids": [value["ready"] for value in ready],
            "compute_pids": [pid for value in ready for pid in value["compute_pids"]],
        }
    finally:
        for process in processes:
            if process.is_alive():
                process.terminate()
            process.join(timeout=5)
        for connection in connections:
            connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--layouts", default="1x0,4x1,4x2,8x1")
    parser.add_argument("--batches", type=int, default=96)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    result = {
        "python": platform.python_version(),
        "platform": platform.platform(),
        "logical_cpus": os.cpu_count(),
        "scope": "real broker CPU stage; warmed pools; independent processes; no sockets/DB/Redis",
        "policy": "fixed total work; active cores = parent and compute CPU seconds / common wall time",
        "layouts": [],
    }
    for layout in args.layouts.split(","):
        workers, event_workers = (int(value) for value in layout.split("x"))
        if workers < 1 or event_workers < 0 or args.repeats < 1 or args.batches < 1:
            raise ValueError("invalid benchmark configuration")
        samples = [
            measure_layout(workers, event_workers, args.batches)
            for _ in range(args.repeats)
        ]
        summary = {**samples[-1], "samples": samples}
        for field in (
            "wall_s",
            "notifications_per_second",
            "average_active_cores",
            "parent_cpu_s",
            "compute_cpu_s",
        ):
            summary[field] = statistics.median(sample[field] for sample in samples)
        result["layouts"].append(summary)
        print(
            json.dumps(
                {key: value for key, value in summary.items() if key != "samples"}
            ),
            flush=True,
        )
    if args.output:
        args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
