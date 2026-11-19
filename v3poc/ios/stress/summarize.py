#!/usr/bin/env python3
"""Summarize one stress run directory (v3poc/ios/stress/run.sh output) into Markdown tables.

Reads app.log ([stress] JSON lines from the app: native / web / feed / events), app.log.test.log (UI test actions),
mem.csv (host samples of the app and WebContent processes) and crashes.txt. Run: python3 -I summarize.py <run dir>
"""
import csv
import json
import sys
from pathlib import Path

run = Path(sys.argv[1])
lines = []
for raw in (run / "app.log").read_text(errors="replace").splitlines() if (run / "app.log").exists() else []:
    if "[stress] " in raw:
        try:
            lines.append(json.loads(raw.split("[stress] ", 1)[1]))
        except json.JSONDecodeError:
            pass
actions = []
if (run / "app.log.test.log").exists():
    for raw in (run / "app.log.test.log").read_text().splitlines():
        try:
            actions.append(json.loads(raw))
        except json.JSONDecodeError:
            pass
mem = list(csv.DictReader((run / "mem.csv").open())) if (run / "mem.csv").exists() else []
wall0 = next((l["wall"] - l["t"] for l in lines if "wall" in l), None)

def by(kind):
    return [l for l in lines if l.get("k") == kind]

def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

def bucket(rows, size=30, key="t"):
    out = {}
    for r in rows:
        out.setdefault(int(r[key] // size) * size, []).append(r)
    return out

def agg(rows, field, how):
    vals = [num(r.get(field)) for r in rows]
    vals = [v for v in vals if v is not None]
    if not vals:
        return ""
    v = {"sum": sum(vals), "max": max(vals), "avg": sum(vals) / len(vals), "last": vals[-1]}[how]
    return f"{v:.0f}" if v >= 100 else f"{v:.1f}"

print(f"# 压测 {run.name}\n")
if (run / "run.txt").exists():
    print("```\n" + (run / "run.txt").read_text().strip() + "\n```\n")

native, web, feed = by("native"), by("web"), by("feed")
print("## 每 30 秒\n")
print("| t (s) | 已完成 item | 线程 item | 推送/s | 桥 KB/s | 每帧最大 KB | 编码均值/最大 ms | eval 往返均值/最大 ms | 合并掉的事件/s | 在途最大 | 原生掉帧 | 原生最长帧 ms "
      "| 页面掉帧 | 页面最长卡顿 ms | >100ms 卡顿 | receive 均值/最大 ms | 到绘制均值/最大 ms | DOM 节点 | 新增/删除节点/s | 页面高度 K px | App footprint MB | App RSS MB | WebContent RSS MB | WebContent CPU % |")
print("|" + "---|" * 24)
nb, wb, fb = bucket(native), bucket(web), bucket([f for f in feed if "t" in f and "finished" in f])
mb = bucket([{**m, "t": float(m["t"])} for m in mem if m.get("t")], key="t")
for t in sorted(set(nb) | set(wb)):
    n, w, f, m = nb.get(t, []), wb.get(t, []), fb.get(t, []), mb.get(t, [])
    secs = max(1, 5 * len(n))
    pushes = sum(num(x.get("pushes")) or 0 for x in f)
    kbs = (sum(num(x.get("kb")) or 0 for x in n) / secs) if n else 0
    print(f"| {t} | {agg(f, 'finished', 'last')} | {agg(f, 'items', 'last')} | {pushes / max(1, 5 * len(f)):.0f} | {kbs:.0f} | {agg(n, 'maxKB', 'max')} "
          f"| {agg(n, 'encodeAvg', 'avg')} / {agg(n, 'encodeMax', 'max')} | {agg(n, 'evalAvg', 'avg')} / {agg(n, 'evalMax', 'max')} "
          f"| {(sum(num(x.get('coalesced')) or 0 for x in n) / secs):.0f} | {agg(n, 'inflightMax', 'max')} | {agg(n, 'uiDropped', 'sum')} | {agg(n, 'uiMaxGap', 'max')} "
          f"| {agg(w, 'dropped', 'sum')} | {agg(w, 'maxGap', 'max')} | {agg(w, 'gaps100', 'sum')} | {agg(w, 'recvAvg', 'avg')} / {agg(w, 'recvMax', 'max')} "
          f"| {agg(w, 'paintAvg', 'avg')} / {agg(w, 'paintMax', 'max')} | {agg(w, 'dom', 'last')} | {(sum(num(x.get('added')) or 0 for x in w) / max(1, 5 * len(w))):.0f} / {(sum(num(x.get('removed')) or 0 for x in w) / max(1, 5 * len(w))):.0f} | {agg(w, 'heightK', 'last')} "
          f"| {agg(n, 'appMB', 'max')} | {agg(m, 'app_rss_mb', 'max')} | {agg(m, 'wcp_rss_mb', 'max')} | {agg(m, 'wcp_cpu', 'avg')} |")

print("\n## 打开会话（快照）\n")
print("| t (s) | 事件 | 数值 |")
print("|---|---|---|")
for l in lines:
    if l.get("k") in ("snapshotSent", "snapshotEval", "snapshotRendered", "snapshotPrepared"):
        detail = {k: v for k, v in l.items() if k not in ("k", "t", "wall")}
        print(f"| {l['t']} | {l['k']} | {json.dumps(detail, ensure_ascii=False)} |")

print("\n## 事件\n")
events = [l for l in lines if l.get("k") in ("event", "wcp") or (l.get("k") == "feed" and "what" in l)]
timeline = [(l.get("t", 0), l.get("what") or l["k"], {k: v for k, v in l.items() if k not in ("k", "t", "wall", "what")}) for l in events]
if wall0 is not None:
    timeline += [(round(a["wall"] - wall0, 1), "UI 测试：" + a["action"], {}) for a in actions]
for t, what, detail in sorted(timeline, key=lambda x: x[0]):
    print(f"- {t:>7} s  {what} {json.dumps(detail, ensure_ascii=False) if detail else ''}")

crashes = (run / "crashes.txt").read_text().split() if (run / "crashes.txt").exists() else []
print(f"\n## 崩溃报告\n\n{', '.join(crashes) if crashes else '没有新的 AAv3PoC-*.ips'}")
