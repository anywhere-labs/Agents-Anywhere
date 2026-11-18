#!/usr/bin/env python3
"""Convert the iOS PoC's icon SVGs into Compose ImageVectors, so both apps draw the very same paths.

Source: v3poc/ios/AAv3PoC/Resources/Assets.xcassets/aa-*.imageset/*.svg (Lucide strokes from Web, plus the agent marks).
Output: app/src/main/java/dev/agentsanywhere/v3poc/design/AAIcons.kt (generated; do not edit by hand).

Supports what those files use: <path d>, <circle>, <rect rx ry>, <line>, the root's fill / stroke / stroke-width /
linecap / linejoin, and a per-element fill (fill="currentColor" on a few dots). Colours are templates: the Kotlin side
tints with the content colour, like the iOS template images.

Run: python3 -I v3poc/android/tools/svg2compose.py
"""
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "ios/AAv3PoC/Resources/Assets.xcassets"
OUT = ROOT / "android/app/src/main/java/dev/agentsanywhere/v3poc/design/AAIcons.kt"
SYMBOLS = ROOT / "ios/AAv3PoC/Components/AppSymbolAssets.swift"


def num(v, default=0.0):
    return float(v) if v not in (None, "") else default


def fmt(x):
    s = f"{x:.4f}".rstrip("0").rstrip(".")
    return s if s not in ("-0", "") else "0"


def circle(cx, cy, r):
    return f"M{fmt(cx - r)} {fmt(cy)}a{fmt(r)} {fmt(r)} 0 1 0 {fmt(2 * r)} 0a{fmt(r)} {fmt(r)} 0 1 0 {fmt(-2 * r)} 0Z"


def rect(x, y, w, h, rx, ry):
    if rx <= 0 and ry <= 0:
        return f"M{fmt(x)} {fmt(y)}h{fmt(w)}v{fmt(h)}h{fmt(-w)}Z"
    rx = min(rx or ry, w / 2)
    ry = min(ry or rx, h / 2)
    return (f"M{fmt(x + rx)} {fmt(y)}H{fmt(x + w - rx)}A{fmt(rx)} {fmt(ry)} 0 0 1 {fmt(x + w)} {fmt(y + ry)}"
            f"V{fmt(y + h - ry)}A{fmt(rx)} {fmt(ry)} 0 0 1 {fmt(x + w - rx)} {fmt(y + h)}H{fmt(x + rx)}"
            f"A{fmt(rx)} {fmt(ry)} 0 0 1 {fmt(x)} {fmt(y + h - ry)}V{fmt(y + ry)}A{fmt(rx)} {fmt(ry)} 0 0 1 {fmt(x + rx)} {fmt(y)}Z")


def convert(svg_path: Path):
    root = ET.parse(svg_path).getroot()
    vb = [float(v) for v in root.get("viewBox", "0 0 24 24").split()]
    base_fill = root.get("fill", "black")
    base_stroke = root.get("stroke", "none")
    width = num(root.get("stroke-width"), 1.0)
    cap = root.get("stroke-linecap", "butt")
    join = root.get("stroke-linejoin", "miter")
    paths = []
    for el in root.iter():
        tag = el.tag.split("}")[-1]
        if tag == "path":
            d = el.get("d")
        elif tag == "circle":
            d = circle(num(el.get("cx")), num(el.get("cy")), num(el.get("r")))
        elif tag == "rect":
            d = rect(num(el.get("x")), num(el.get("y")), num(el.get("width")), num(el.get("height")),
                     num(el.get("rx"), 0), num(el.get("ry"), 0))
        elif tag == "line":
            d = f"M{el.get('x1')} {el.get('y1')}L{el.get('x2')} {el.get('y2')}"
        else:
            continue
        fill = el.get("fill", base_fill)
        stroke = el.get("stroke", base_stroke)
        paths.append((d, fill not in ("none", None), stroke not in ("none", None)))
    return vb, width, cap, join, paths


# SF Symbols the iOS PoC uses directly (not through AppSymbolAssets): the closest Lucide icons, inline.
EXTRAS = {
    "ChevronLeft": '<svg viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
    "CircleStop": '<svg viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>',
    "SquareFill": '<svg viewBox="0 0 24 24" fill="#000" stroke="none"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>',
}


def kotlin_string(s):
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("$", "\\$") + '"'


def main():
    files = sorted(SRC.glob("aa-*.imageset/*.svg"))
    if not files:
        sys.exit(f"no SVGs under {SRC}")
    caps = {"round": "StrokeCap.Round", "square": "StrokeCap.Square", "butt": "StrokeCap.Butt"}
    joins = {"round": "StrokeJoin.Round", "bevel": "StrokeJoin.Bevel", "miter": "StrokeJoin.Miter"}
    entries = []
    import tempfile
    extra_files = []
    tmp = Path(tempfile.mkdtemp())
    for name, svg in EXTRAS.items():
        (tmp / f"aa-{name}.imageset").mkdir()
        (tmp / f"aa-{name}.imageset" / f"{name}.svg").write_text(svg)
        extra_files.append(tmp / f"aa-{name}.imageset" / f"{name}.svg")
    for f in sorted(files + extra_files, key=lambda p: p.parent.name):
        name = f.parent.name.removeprefix("aa-").removesuffix(".imageset")
        vb, width, cap, join, paths = convert(f)
        body = ",\n".join(f"            P({kotlin_string(d)}, fill = {str(fl).lower()}, stroke = {str(st).lower()})" for d, fl, st in paths)
        entries.append(f'        "{name}" to Spec({fmt(vb[2])}f, {fmt(vb[3])}f, {fmt(width)}f, {caps[cap]}, {joins[join]}, listOf(\n{body},\n        )),')
    sf = dict(re.findall(r'"([^"]+)": "aa-([^"]+)"', SYMBOLS.read_text())) if SYMBOLS.exists() else {}
    sf_lines = "\n".join(f'        "{k}" to "{v}",' for k, v in sorted(sf.items()))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(f"""// GENERATED by v3poc/android/tools/svg2compose.py from the iOS PoC's Assets.xcassets/aa-*.svg. Do not edit.
@file:Suppress("SpellCheckingInspection")

package dev.agentsanywhere.v3poc.design

import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.dp

/** The same vectors as iOS `AppSymbol` / `SessionAgentIcon`: drawn black, tinted by the caller. */
object AAIcons {{
    private class P(val d: String, val fill: Boolean, val stroke: Boolean)
    private class Spec(val w: Float, val h: Float, val strokeWidth: Float, val cap: StrokeCap, val join: StrokeJoin, val paths: List<P>)

    private val specs: Map<String, Spec> = mapOf(
{chr(10).join(entries)}
    )

    /** iOS SF Symbol names → asset names (`AppSymbolAssets.names`), so Kotlin can use the same names as Swift. */
    val sfSymbols: Map<String, String> = mapOf(
{sf_lines}
    )

    private val cache = HashMap<String, ImageVector>()

    val names: Set<String> get() = specs.keys

    /** By asset name ("Copy", "AgentCodex") or by the SF Symbol name iOS uses ("doc.on.doc"). */
    fun get(name: String): ImageVector = cache.getOrPut(name) {{
        val spec = specs[name] ?: specs[sfSymbols[name] ?: ""] ?: specs.getValue("CircleHelp")
        val builder = ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = spec.w, viewportHeight = spec.h)
        for (p in spec.paths) {{
            builder.addPath(
                pathData = PathParser().parsePathString(p.d).toNodes(),
                fill = if (p.fill) SolidColor(Color.Black) else null,
                stroke = if (p.stroke) SolidColor(Color.Black) else null,
                strokeLineWidth = if (p.stroke) spec.strokeWidth else 0f,
                strokeLineCap = spec.cap,
                strokeLineJoin = spec.join,
            )
        }}
        builder.build()
    }}
}}
""")
    print(f"{len(files)} icons → {OUT.relative_to(ROOT)}")


main()
