#!/usr/bin/env python3
"""WCAG contrast of the glass controls' text and icons, from v3poc/design/tokens.json, light and dark.

Worst case for blurred glass: the tint composited over pure white, pure black and the thread's lightest / darkest
content (code block, user bubble, image), as if the blur had flattened them to one colour. Solid glass is checked over
its own opaque colour. Text needs 4.5:1; large text (>= 18 sp, or >= 14 sp bold), icons and control edges 3:1.

  python3 -I v3poc/android/tools/contrast.py [out.md]      (default: print)
Also prints the smallest blur-tint opacity that passes everything, to choose `glassTintBlur`.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
T = json.loads((ROOT / "v3poc/design/tokens.json").read_text())["color"]


def rgba(h):
    h = h.lstrip("#")
    return [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)] + [int(h[6:8], 16) / 255 if len(h) == 8 else 1.0]


def over(top, bottom):
    a = top[3]
    return [top[i] * a + bottom[i] * (1 - a) for i in range(3)] + [1.0]


def lum(c):
    f = lambda v: v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (f(v) for v in c[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def col(name, dark):
    return rgba(T[name][1 if dark else 0])


# The thread's extremes under a control (renderer colours, from the screenshots): code block, user bubble, image.
UNDER = {
    False: {"白": "#FFFFFF", "黑": "#000000", "代码块": "#F5F5F5", "用户气泡": "#F2F2F2", "深色图片": "#1A2233"},
    True: {"白": "#FFFFFF", "黑": "#000000", "代码块": "#1C1C1E", "用户气泡": "#2C2C2E", "浅色图片": "#E6EDF7"},
}

# (what, text colour token, surface, minimum ratio)
CHECKS = [
    ("顶栏标题", "label", "glass", 4.5),
    ("顶栏副标题（Agent · 设备 · 状态）", "controlSecondaryLabel", "glass", 4.5),
    ("顶栏图标", "label", "glass", 3.0),
    ("输入框占位符", "controlSecondaryLabel", "glass", 4.5),
    ("输入框输入的文字", "label", "glass", 4.5),
    ("审批区标题", "label", "glass", 4.5),
    ("审批区命令（等宽）", "controlSecondaryLabel", "glass", 4.5),
    ("审批区按钮文字（次要按钮底）", "label", "button", 4.5),
    ("审批区主按钮文字", "primaryControlForeground", "prominent", 4.5),
    ("「到底部」文字", "label", "glass", 4.5),
]


def surfaces(dark, tint_blur):
    """name -> list of (under label, surface colour)."""
    out = {}
    blur = []
    for k, v in UNDER[dark].items():
        blur.append((f"模糊 / {k}", over(tint_blur, rgba(v + "FF"))))
    out["glass"] = blur + [("实色", col("glassTintOpaque", dark))]
    out["button"] = [("实色（叠在审批区上）", col("glassButtonTint", dark))]
    out["prominent"] = [("主按钮", col("primaryControlBackground", dark))]
    return out


def run(dark, tint_blur):
    rows, worst_fail = [], False
    s = surfaces(dark, tint_blur)
    for what, text, surface, need in CHECKS:
        for under, bg in s[surface]:
            fg = over(col(text, dark), bg)
            r = ratio(fg, bg)
            ok = r >= need
            worst_fail |= not ok
            rows.append((what, under, f"{r:.2f}", f"{need:g}", "通过" if ok else "**不通过**"))
    # Control edge: the glass stroke against the page (3:1 is not reachable for a hairline on glass; reported only).
    return rows, worst_fail


def min_alpha(dark):
    base = col("glassTintBlur", dark)
    for step in range(0, 101):
        a = step / 100
        tint = base[:3] + [a]
        if not run(dark, tint)[1]:
            return a
    return None


lines = ["# 玻璃控件对比度（tokens.json）", "",
         "按 WCAG：文字 4.5:1；大字、图标 3:1。模糊玻璃按最坏情况算：着色叠在纯白、纯黑和线程里最亮 / 最暗的内容上（相当于模糊把下层抹成一种颜色）。", ""]
for dark in (False, True):
    tint = col("glassTintBlur", dark)
    rows, fail = run(dark, tint)
    lines += [f"## {'深色' if dark else '浅色'}（模糊着色 {T['glassTintBlur'][1 if dark else 0]}，"
              f"全部通过所需的最低不透明度 {min_alpha(dark)}）", "",
              "| 元素 | 下层 | 对比度 | 要求 | 结果 |", "|---|---|---|---|---|"]
    lines += [f"| {' | '.join(r)} |" for r in rows]
    lines.append("")
# ── Kyant material (catalog parameters) ─────────────────────────────────────────────────────────────────────────────
# Realistic "blurred thread" averages too: blur turns the page with text into a light (dark) grey, not pure black.
REAL = {False: {"模糊后的线程（约 #E9E9E9）": "#E9E9E9"}, True: {"模糊后的线程（约 #1C1C1C）": "#1C1C1C"}}


def kyant_rows(dark, surface_token, text, need, alpha=None):
    surf = col(surface_token, dark)
    if alpha is not None:
        surf = surf[:3] + [alpha]
    out = []
    for k, v in list(UNDER[dark].items()) + list(REAL[dark].items()):
        bg = over(surf, rgba(v + "FF"))
        r = ratio(over(col(text, dark), bg), bg)
        out.append((k, r, r >= need))
    return out


def min_surface(dark, surface_token, texts):
    for step in range(0, 101):
        a = step / 100
        if all(ok for t, need in texts for _, _, ok in kyant_rows(dark, surface_token, t, need, a)
               if True):
            return a
    return None


lines += ["# Kyant 材质（catalog 参数）", "",
          "按钮和胶囊：LiquidButton（vibrancy、blur 2 dp、lens 12/24 dp、Kyant 高光和阴影、`liquidButtonSurface`）。"
          "面板（输入框、审批区）：LiquidBottomTabs 的容器（vibrancy、blur 8 dp、lens 24/24 dp、`liquidPanelSurface`）。"
          "vibrancy 只提高饱和度，不改变亮度，下面按着色叠在下层上计算。", ""]
for dark in (False, True):
    name = "深色" if dark else "浅色"
    lines += [f"## {name}", "", "| 元素 | 下层 | 对比度 | 要求 | 结果 |", "|---|---|---|---|---|"]
    for what, surface, text, need in [
        ("圆按钮图标、「到底部」图标", "liquidButtonSurface", "label", 3.0),
        ("「到底部」文字", "liquidButtonSurface", "label", 4.5),
        ("输入框占位符", "liquidPanelSurface", "controlSecondaryLabel", 4.5),
        ("审批区标题", "liquidPanelSurface", "label", 4.5),
        ("审批区命令文字", "liquidPanelSurface", "controlSecondaryLabel", 4.5),
    ]:
        for k, r, ok in kyant_rows(dark, surface, text, need):
            lines.append(f"| {what} | {k} | {r:.2f} | {need:g} | {'通过' if ok else '**不通过**'} |")
    a_panel = min_surface(dark, "liquidPanelSurface", [("label", 4.5), ("controlSecondaryLabel", 4.5)])
    a_btn = min_surface(dark, "liquidButtonSurface", [("label", 3.0)])
    lines += ["", f"最坏下层全部达标所需的着色不透明度：面板 {a_panel}（示例 {T['liquidPanelSurface'][1 if dark else 0]}），"
              f"按钮图标 {a_btn}（示例 {T['liquidButtonSurface'][1 if dark else 0]}）。", ""]

# Top edge: the veil (page colour, 0.9 at the top, smoothstep to 0 at the band bottom) at the title and subtitle.
lines += ["# 顶部模糊渐变带上的标题", "",
          "带高 = 状态栏 53 dp + 顶栏 44 dp + 24 dp；标题中线在 75 dp（t≈0.62），副标题在 ~85 dp（t≈0.70）。着色 = 页面色 × 0.9 × (1 − smoothstep(t))。", "",
          "| 主题 | 元素 | 着色不透明度 | 下层 | 对比度 | 要求 |", "|---|---|---|---|---|---|"]
for dark in (False, True):
    for what, t, text in [("标题", 0.62, "label"), ("副标题", 0.70, "controlSecondaryLabel")]:
        a = 0.9 * (1 - t * t * (3 - 2 * t))
        veil = col("toolbarEdgeTint", dark)[:3] + [a]
        for k, v in list(UNDER[dark].items()) + list(REAL[dark].items()):
            bg = over(veil, rgba(v + "FF"))
            r = ratio(over(col(text, dark), bg), bg)
            lines.append(f"| {'深色' if dark else '浅色'} | {what} | {a:.2f} | {k} | {r:.2f} | 4.5 |")
lines.append("")
text = "\n".join(lines)
if len(sys.argv) > 1:
    Path(sys.argv[1]).write_text(text + "\n")
    print(sys.argv[1])
else:
    print(text)
