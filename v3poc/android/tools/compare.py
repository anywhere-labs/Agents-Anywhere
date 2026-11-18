"""Side-by-side iOS | Android screenshots at the same logical scale (2 px per pt/dp).

usage: python3 compare.py IOS.png ANDROID.png OUT.png [--android-density 2.625] [--ios-scale 3]
Needs Pillow.
"""
import argparse

from PIL import Image, ImageDraw

p = argparse.ArgumentParser()
p.add_argument("ios")
p.add_argument("android")
p.add_argument("out")
p.add_argument("--android-density", type=float, default=2.625)
p.add_argument("--ios-scale", type=float, default=3.0)
p.add_argument("--px-per-unit", type=float, default=2.0)
a = p.parse_args()


def scaled(path, factor):
    im = Image.open(path).convert("RGB")
    return im.resize((round(im.width * factor), round(im.height * factor)), Image.LANCZOS)


ios = scaled(a.ios, a.px_per_unit / a.ios_scale)
android = scaled(a.android, a.px_per_unit / a.android_density)
gap, label = 24, 40
out = Image.new("RGB", (ios.width + gap + android.width, label + max(ios.height, android.height)), "#808080")
d = ImageDraw.Draw(out)
d.text((8, 12), f"iOS {a.ios.split('/')[-1]} ({ios.width / a.px_per_unit:.0f} pt)", fill="white")
d.text((ios.width + gap + 8, 12), f"Android ({android.width / a.px_per_unit:.0f} dp)", fill="white")
out.paste(ios, (0, label))
out.paste(android, (ios.width + gap, label))
out.save(a.out)
print(a.out, out.size)
