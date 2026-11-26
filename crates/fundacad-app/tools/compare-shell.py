# The shell next to a capture of the Vue workspace at the same size: a side by side, an amplified difference, and per
# region the mean and the count of pixels off by more than 24 in any channel. Trust the count over the mean.
#   python compare-shell.py vue.png gpui.png out-dir
# Both captures must be 1440x900 at 100% scaling, in the same theme. The 3D view differs on purpose (the Vue capture
# has a model and grid), so it is left out, but the glass regions show it through: only the title bar and History
# measure the shell alone.
import os
import sys

from PIL import Image, ImageChops

if len(sys.argv) != 4:
    sys.exit("usage: compare-shell.py vue.png gpui.png out-dir")
vue, gpui, out = sys.argv[1:4]
v = Image.open(vue).convert("RGB")
g = Image.open(gpui).convert("RGB")
if v.size != g.size or v.size != (1440, 900):
    sys.exit(f"sizes differ or are not 1440x900: vue {v.size}, gpui {g.size}")
os.makedirs(out, exist_ok=True)

side = Image.new("RGB", (v.width * 2 + 8, v.height), "red")
side.paste(v, (0, 0))
side.paste(g, (v.width + 8, 0))
side.save(f"{out}/side.png")
diff = ImageChops.difference(v, g)
diff.point(lambda x: min(255, x * 4)).save(f"{out}/diff.png")

REGIONS = {
    "title bar": (0, 0, 1440, 36),
    "items card": (12, 48, 276, 888),
    "rail tiles": (288, 48, 328, 888),
    "rail labels": (334, 48, 500, 888),
    "view controls": (1080, 48, 1128, 610),
    "history card": (1140, 48, 1428, 286),
}
for name, box in REGIONS.items():
    px = [max(p) for p in diff.crop(box).getdata()]
    print(f"{name:14} mean abs diff {sum(px) / len(px):5.2f}, pixels > 24: {sum(1 for p in px if p > 24)}")
