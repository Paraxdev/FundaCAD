"""The text oracle: glyph faces measured on the Python engine.

Runs sidecar/sketch_build.py `_text_faces` (Font_FontMgr and StdPrs_BRepFont
through build123d) over every case and writes fixtures.json: per face its area,
exact 2D bounding box and hole count. The Rust engine lays glyphs out itself
from ttf-parser outlines, so crates/fundacad-geom/tests/text_oracle.rs compares
within tolerances rather than byte for byte. The fonts are the ones Windows
ships, so a case whose font does not resolve on the machine running the test is
skipped there.

Run from the repository root:
    sidecar/.venv/Scripts/python.exe crates/fundacad-geom/tests/text/gen_fixtures.py
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SIDECAR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "sidecar"))
sys.path.insert(0, SIDECAR)
os.environ.setdefault("FUNDACAD_DISK_CACHE", "0")

import font_guard  # noqa: E402

font_guard.ensure()

import sketch_build  # noqa: E402
from OCP.Bnd import Bnd_Box  # noqa: E402
from OCP.BRepBndLib import BRepBndLib  # noqa: E402


def text(s, height=10, **extra):
    e = {"type": "text", "text": s, "height": height}
    e.update(extra)
    return e


ARC = {"type": "arc", "x1": -40, "y1": 0, "x2": 40, "y2": 0, "mx": 0, "my": 40}
LINE = {"type": "line", "x1": 0, "y1": 0, "x2": 80, "y2": 30}

CASES = {
    "arial_hello": (text("Hello"), None),
    "arial_counters": (text("B8%@", font="Arial"), None),
    "arial_bold_center": (text("FundaCAD 123", 8, font="Arial", style="bold", align="center"), None),
    "arial_kerning": (text("AVATAR Tokyo", 12, font="Arial"), None),
    "times_italic_rotated": (text("Ag Qj", 15, font="Times New Roman", style="italic", angle=30, x=5, y=-3), None),
    "consolas_right": (text("O0{}#", 6, font="Consolas", align="right"), None),
    "courier_alias_bolditalic": (text("Mix", 10, font="Courier", style="bolditalic"), None),
    "segoe_dots": (text("iji?!", 20, font="Segoe UI"), None),
    "georgia_multiline": (text("Two\nlines here", 10, font="Georgia", align="center"), None),
    "arial_wrapped": (text("wrap these words into a narrow box", 5, font="Arial", boxWidth=30), None),
    "unknown_font_falls_back": (text("Nope", 10, font="NoSuchFontAnywhere", style="italic"), None),
    "arial_black_bold_missing": (text("Heavy", 10, font="Arial Black", style="bold"), None),
    "synthetic_italic": (text("Slant", 10, font="Arial Black", style="italic"), None),
    "unicode_accents": (text("Ünï © été", 10, font="Arial"), None),
    "on_arc": (text("CURVED", 6, font="Arial"), ARC),
    "on_line_offset": (text("path", 8, font="Arial", positionOnPath=0.25), LINE),
    "blank": (text("   ", 10), None),
}


def bbox(shape):
    b = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape.wrapped, b, True, False)
    x0, y0, _z0, x1, y1, _z1 = b.Get()
    return [x0, y0, x1, y1]


def run(entity, path):
    def v(x):
        return sketch_build._num_or(x, 0.0)

    path_edge = sketch_build._entity_edge(path, v) if path else None
    faces = sketch_build._text_faces(entity, v, path_edge)
    tess = sketch_build.tessellate_text(entity, path)
    return {
        "faces": [{"area": f.area, "bbox": bbox(f), "holes": len(f.inner_wires())} for f in faces],
        "tessellated": [{"outer": len(f["outer"]) > 2, "holes": len(f["holes"])} for f in tess["faces"]],
    }


def main():
    out = {}
    for name, (entity, path) in CASES.items():
        out[name] = {"entity": entity, "pathEntity": path, "expect": run(entity, path)}
        print(name, len(out[name]["expect"]["faces"]))
    with open(os.path.join(HERE, "fixtures.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write("\n")


if __name__ == "__main__":
    main()
