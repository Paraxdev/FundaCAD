# The shell next to a 1440x900 capture of the Vue workspace: a side by side, an amplified difference, and the mean
# difference per region. The 3D view differs on purpose (the Vue capture has a model and grid), so it is left out.
#   python compare-shell.py vue.png gpui.png out-dir
import sys
from PIL import Image, ImageChops

vue, gpui, out = sys.argv[1:4]
v = Image.open(vue).convert("RGB")
g = Image.open(gpui).convert("RGB")
side = Image.new("RGB", (v.width * 2 + 8, v.height), "red")
side.paste(v, (0, 0))
side.paste(g, (v.width + 8, 0))
side.save(f"{out}/side.png")
ImageChops.difference(v, g).convert("L").point(lambda x: min(255, x * 4)).save(f"{out}/diff.png")

REGIONS = {
    "title bar": (0, 0, 1440, 36),
    "items card": (12, 48, 276, 888),
    "rail tiles": (288, 48, 328, 888),
    "view controls": (1080, 48, 1128, 610),
    "history card": (1140, 48, 1428, 286),
}
for name, box in REGIONS.items():
    px = list(ImageChops.difference(v.crop(box), g.crop(box)).convert("L").getdata())
    print(f"{name:14} mean abs diff {sum(px) / len(px):5.2f}, pixels > 24: {sum(1 for p in px if p > 24)}")
