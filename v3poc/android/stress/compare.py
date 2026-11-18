#!/usr/bin/env python3
"""Key numbers of several stress runs side by side (Markdown). Run: python3 -I compare.py <run dir> [<run dir> …]

Each column is one run directory written by v3poc/android/stress/run.sh or v3poc/ios/stress/run.sh (same layout). `cut` seconds: only the first part of a run is counted (an option
`dir:cut`, e.g. base-burst:322 for the baseline whose app was swiped away at 331 s).
"""
import csv
import json
import sys
from pathlib import Path


def load(arg):
    path, _, cut = arg.partition(":")
    run = Path(path)
    cut = float(cut) if cut else float("inf")
    lines = []
    for raw in (run / "app.log").read_text(errors="replace").splitlines():
        if "[stress] " in raw:
            try:
                l = json.loads(raw.split("[stress] ", 1)[1])
            except json.JSONDecodeError:
                continue
            if l.get("t", 0) < cut:
                lines.append(l)
    mem = [r for r in csv.DictReader((run / "mem.csv").open()) if r.get("t") and float(r["t"]) < cut]
    return run.name, lines, mem, cut


def stats(name, lines, mem, cut):
    nat = [l for l in lines if l.get("k") == "native"]
    web = [l for l in lines if l.get("k") == "web"]
    feed = [l for l in lines if l.get("k") == "feed" and "items" in l]
    end = max([l["t"] for l in web] or [0])

    def drop(ws):
        f = sum(w["frames"] for w in ws)
        d = sum(w["dropped"] for w in ws)
        return f"{100 * d / max(1, f + d):.0f}%" if ws else "–"

    def avg(ws, k):
        return sum(w.get(k, 0) for w in ws) / max(1, len(ws))

    first = [w for w in web if w["t"] < 60]
    last = [w for w in web if w["t"] >= end - 60]
    lastn = [l for l in nat if l["t"] >= end - 60]
    wc = [float(r["wcp_rss_mb"]) for r in mem if r.get("wcp_rss_mb")]
    items = feed[-1]["items"] if feed else 0
    kb = sum(l["kb"] for l in nat)
    snaps = {l["k"]: l for l in lines if l.get("k") in ("snapshotEval", "snapshotRendered", "snapshotSent")}
    first_render = next((l for l in lines if l.get("k") == "snapshotRendered"), None)
    first_eval = next((l for l in lines if l.get("k") == "snapshotEval"), None)
    first_sent = next((l for l in lines if l.get("k") == "snapshotSent"), None)
    return {
        "完成 item": f"{feed[-1]['finished']:.0f}" if feed else "–",
        "桥流量（倍数）": f"{kb / 1024:.0f} MB (×{kb / max(1, items * 24.7):.0f})" if items else f"{kb / 1024:.0f} MB",
        "掉帧 全程 / 末分钟": f"{drop(web)} / {drop(last)}",
        "最长卡顿": f"{max([w['maxGap'] for w in web] or [0]):.0f} ms",
        ">100 ms 卡顿": f"{sum(w['gaps100'] for w in web)}",
        "到绘制 首分钟→末分钟": f"{avg(first, 'paintAvg'):.0f} → {avg(last, 'paintAvg'):.0f} ms",
        "receive 最大": f"{max([w['recvMax'] for w in web] or [0]):.0f} ms",
        "eval 往返 末分钟均值 / 最大": f"{avg(lastn, 'evalAvg'):.0f} / {max([l['evalMax'] for l in nat] or [0]):.0f} ms",
        "在途最大": f"{max([l['inflightMax'] for l in nat] or [0]):.0f}",
        "合并掉的事件": f"{sum(l.get('coalesced', 0) for l in nat):.0f}",
        "渲染进程 RSS 起→止（峰值）": f"{wc[0]:.0f} → {wc[-1]:.0f} ({max(wc):.0f}) MB" if wc else "–",
        "App 内存 起→止（iOS footprint / Android PSS）": f"{min(l['appMB'] for l in nat):.0f} → {nat[-1]['appMB']:.0f} MB" if nat else "–",
        "DOM 末": f"{web[-1]['dom']}" if web else "–",
        "首个快照 字节 / eval / 画出": (f"{first_sent['bytes'] / 1048576:.1f} MB / {first_eval['ms']:.0f} ms / {first_render['ms']:.0f} ms"
                                if first_sent and first_eval and first_render else "–"),
    }


runs = [stats(*load(a)) for a in sys.argv[1:]]
names = [Path(a.partition(":")[0]).name + (f" (前 {a.partition(':')[2]} s)" if a.partition(":")[2] else "") for a in sys.argv[1:]]
print("| 指标 | " + " | ".join(names) + " |")
print("|---|" + "---|" * len(names))
for key in runs[0]:
    print(f"| {key} | " + " | ".join(r[key] for r in runs) + " |")
