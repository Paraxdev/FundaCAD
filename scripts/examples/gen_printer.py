"""Writes a generic cube frame printer as a gzipped AP214 STEP with names and colours, for the 3,000 part import test.

    uv run --no-project --python 3.12 --with cadquery-ocp==7.9.3.1.1 scripts/examples/gen_printer.py --leaves 3000 tests/fixtures/printer_3000.stpz

Leaves past the base parts are screws and T-nuts along the frame rails. A rerun gives the same bytes.
It prints the leaf count, each subassembly's count and the model's bounding box.
"""

import argparse
import gzip
import json
import math
import os
import re
import tempfile

from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut, BRepAlgoAPI_Fuse
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCone, BRepPrimAPI_MakeCylinder, BRepPrimAPI_MakePrism
from OCP.Bnd import Bnd_Box
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_ColorGen, XCAFDoc_DocumentTool, XCAFDoc_ShapeTool
from OCP.gp import gp_Ax2, gp_Ax3, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

ALUMINIUM = (0.70, 0.72, 0.75)
BLACK = (0.10, 0.10, 0.12)
STEEL = (0.86, 0.87, 0.89)
BRASS = (0.80, 0.60, 0.20)
RED = (0.75, 0.12, 0.10)
ORANGE = (0.95, 0.45, 0.05)
GREEN = (0.10, 0.45, 0.20)
BLUE = (0.15, 0.25, 0.60)
YELLOW = (0.95, 0.80, 0.10)
GREY = (0.45, 0.47, 0.50)
GOLD = (0.85, 0.70, 0.30)

FRAME = 360
HEIGHT = 400
FOOT = 10


def solid(shape):
    found = []
    ex = TopExp_Explorer(shape, TopAbs_SOLID)
    while ex.More():
        found.append(ex.Current())
        ex.Next()
    assert len(found) == 1, f"a part must be one solid, got {len(found)}"
    return found[0]


def box(x0, y0, z0, x1, y1, z1):
    return BRepPrimAPI_MakeBox(gp_Pnt(x0, y0, z0), gp_Pnt(x1, y1, z1)).Shape()


def cyl(r, h, x=0.0, y=0.0, z=0.0, axis=(0, 0, 1)):
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x, y, z), gp_Dir(*axis)), r, h).Shape()


def cut(a, *tools):
    for t in tools:
        a = BRepAlgoAPI_Cut(a, t).Shape()
    return solid(a)


def fuse(a, *more):
    for m in more:
        a = BRepAlgoAPI_Fuse(a, m).Shape()
    return solid(a)


def prism_xz(points, depth):
    poly = BRepBuilderAPI_MakePolygon()
    for x, z in points:
        poly.Add(gp_Pnt(x, 0, z))
    poly.Close()
    face = BRepBuilderAPI_MakeFace(poly.Wire()).Face()
    return BRepPrimAPI_MakePrism(face, gp_Vec(0, depth, 0)).Shape()


def hexagon(across_flats, h):
    r = across_flats / math.sqrt(3)
    poly = BRepBuilderAPI_MakePolygon()
    for k in range(6):
        a = math.pi / 3 * k
        poly.Add(gp_Pnt(r * math.cos(a), r * math.sin(a), 0))
    poly.Close()
    return BRepPrimAPI_MakePrism(BRepBuilderAPI_MakeFace(poly.Wire()).Face(), gp_Vec(0, 0, h)).Shape()


def parts():
    """Each part's name, colour and solid, in local coordinates."""
    p = {}

    def add(name, colour, shape):
        p[name] = (colour, solid(shape))

    add("Extrusion 2020 x 400", ALUMINIUM, cut(box(-10, -10, 0, 10, 10, HEIGHT), cyl(2.1, HEIGHT)))
    add(
        "Extrusion 2020 x 320",
        ALUMINIUM,
        cut(box(0, -10, -10, FRAME - 40, 10, 10), cyl(2.1, FRAME - 40, axis=(1, 0, 0))),
    )
    bracket = prism_xz([(0, 0), (20, 0), (20, 3), (3, 3), (3, 20), (0, 20)], 20)
    add("Corner bracket", BLACK, bracket.Moved(TopLoc_Location(shifted(0, -10, 0))))
    add("Foot", BLACK, cyl(15, FOOT))
    add("Stepper motor", BLACK, fuse(box(-21, -21, 0, 21, 21, 40), cyl(2.5, 24, z=40)))
    add("Smooth rod 8 x 340", STEEL, cyl(4, 340))
    add("Lead screw 8 x 300", BRASS, cyl(4, 300))
    add("Shaft coupler", STEEL, cut(cyl(10, 25), cyl(2.5, 25)))
    add("Pulley", STEEL, cut(cyl(6.5, 16), cyl(2.5, 16)))
    add("Idler", STEEL, cut(cyl(9, 9), cyl(2.5, 9)))
    add("Belt", BLACK, box(0, -0.75, -3, 300, 0.75, 3))
    add("Linear bearing", STEEL, cut(cyl(7.5, 24), cyl(4, 24)))
    add("X end", ORANGE, cut(box(-20, -15, -25, 20, 15, 25), cyl(7.6, 50, z=-25)))
    add("Rod holder", ORANGE, cut(box(-10, -7, -10, 10, 7, 10), cyl(4, 20, y=-10, axis=(0, 1, 0))))
    add("Heated bed", RED, box(-110, -110, 0, 110, 110, 3))
    add("Bed carriage", ALUMINIUM, cut(box(-115, -115, 0, 115, 115, 4), box(-80, -80, 0, 80, 80, 4)))
    add("Bed spring", YELLOW, cut(cyl(4, 12), cyl(3, 12)))
    add("Levelling knob", BLACK, cyl(12, 8))
    add("Print sheet", GOLD, box(-110, -110, 0, 110, 110, 1))
    add("Carriage plate", ORANGE, box(-30, -5, -30, 30, 5, 30))
    add("Heatsink", ALUMINIUM, cyl(11, 26))
    add("Heater block", ALUMINIUM, box(-10, -8, 0, 10, 8, 11))
    add("Nozzle", BRASS, BRepPrimAPI_MakeCone(3, 0.5, 6).Shape())
    add("Part fan", BLACK, cut(box(-25, -25, 0, 25, 25, 15), cyl(20, 15)))
    add("Hotend fan", BLACK, cut(box(-15, -15, 0, 15, 15, 10), cyl(13, 10)))
    add("Fan shroud", ORANGE, box(-20, -10, 0, 20, 10, 30))
    add("Extruder", ORANGE, box(-22.5, -22.5, 0, 22.5, 22.5, 30))
    add("Power supply", GREY, box(0, 0, 0, 200, 40, 100))
    add("Main board", GREEN, box(0, 0, 0, 100, 75, 1.6))
    add("Board case", BLACK, cut(box(0, 0, 0, 110, 90, 30), box(2, 2, 2, 108, 88, 30)))
    add("Display", BLUE, box(0, 0, 0, 90, 10, 55))
    add("Display knob", BLACK, cyl(6, 12, axis=(0, -1, 0)))
    add("Power switch", BLACK, box(0, 0, 0, 20, 13, 15))
    add("M5 screw", BLACK, fuse(cyl(4.25, 5), cyl(2.5, 10, z=-10)))
    add("T-nut", STEEL, cut(hexagon(8, 4), cyl(2.5, 4)).Moved(TopLoc_Location(shifted(0, 0, -6))))
    return p


def shifted(x, y, z):
    t = gp_Trsf()
    t.SetTranslation(gp_Vec(x, y, z))
    return t


def at(origin, z=(0, 0, 1), x=(1, 0, 0)):
    t = gp_Trsf()
    t.SetDisplacement(gp_Ax3(), gp_Ax3(gp_Pnt(*origin), gp_Dir(*z), gp_Dir(*x)))
    return TopLoc_Location(t)


X, Y, Z = (1, 0, 0), (0, 1, 0), (0, 0, 1)
NX, NY, NZ = (-1, 0, 0), (0, -1, 0), (0, 0, -1)


def frame_rails():
    """Each rail's start, direction and length, verticals first."""
    lo, hi = 10, FRAME - 10
    rails = [((x, y, FOOT), Z, HEIGHT) for x in (lo, hi) for y in (lo, hi)]
    for z in (FOOT + 10, FOOT + HEIGHT - 10):
        rails += [((20, y, z), X, FRAME - 40) for y in (lo, hi)]
        rails += [((x, 20, z), Y, FRAME - 40) for x in (lo, hi)]
    return rails


def layout():
    """(subassembly, part, location) for every base part."""
    out = []
    lo, hi = 10, FRAME - 10
    top = FOOT + HEIGHT
    for start, d, _ in frame_rails():
        if d == Z:
            out.append(("Frame", "Extrusion 2020 x 400", at(start)))
        else:
            out.append(("Frame", "Extrusion 2020 x 320", at(start, Z, d)))
    for x, y in ((lo, lo), (hi, lo), (lo, hi), (hi, hi)):
        out.append(("Frame", "Foot", at((x, y, 0))))
    for z, up in ((FOOT + 20, Z), (top - 20, NZ)):
        for y in (lo, hi):
            out.append(("Frame", "Corner bracket", at((20, y, z), up, X)))
            out.append(("Frame", "Corner bracket", at((FRAME - 20, y, z), up, NX)))
        for x in (lo, hi):
            out.append(("Frame", "Corner bracket", at((x, 20, z), up, Y)))
            out.append(("Frame", "Corner bracket", at((x, FRAME - 20, z), up, NY)))

    motors = [(45, 30, top - 60), (180, FRAME - 45, FOOT + 20), (45, 180, FOOT + 20), (FRAME - 45, 180, FOOT + 20)]
    for m in motors:
        out.append(("Motion", "Stepper motor", at(m)))
    for x in (45, FRAME - 45):
        out.append(("Motion", "Shaft coupler", at((x, 180, FOOT + 84))))
        out.append(("Motion", "Lead screw 8 x 300", at((x, 180, FOOT + 100))))
        out.append(("Motion", "Smooth rod 8 x 340", at((x + 25, 180, FOOT + 40))))
        out.append(("Motion", "Linear bearing", at((x + 25, 180, 260))))
        out.append(("Motion", "X end", at((x + 10, 180, 270))))
    for y in (165, 195):
        out.append(("Motion", "Smooth rod 8 x 340", at((10, y, 280), X, Y)))
        out.append(("Motion", "Linear bearing", at((168, y, 280), X, Y)))
        for x in (20, FRAME - 20):
            out.append(("Motion", "Rod holder", at((x, y, 280))))
    for x in (120, 240):
        out.append(("Motion", "Smooth rod 8 x 340", at((x, 10, FOOT + 50), Y, NX)))
        for y in (150, 210):
            out.append(("Motion", "Linear bearing", at((x, y - 12, FOOT + 50), Y, NX)))
        for y in (20, FRAME - 20):
            out.append(("Motion", "Rod holder", at((x, y, FOOT + 50), Z, Y)))
    out.append(("Motion", "Pulley", at((45, 30, top - 20))))
    out.append(("Motion", "Pulley", at((180, FRAME - 45, FOOT + 64))))
    out.append(("Motion", "Idler", at((FRAME - 45, 30, top - 20))))
    out.append(("Motion", "Idler", at((180, 45, FOOT + 64))))
    out.append(("Motion", "Belt", at((30, 30, top - 15))))
    out.append(("Motion", "Belt", at((180, 30, FOOT + 70), Z, Y)))

    bed = (180, 180, FOOT + 80)
    out.append(("Bed", "Bed carriage", at(bed)))
    out.append(("Bed", "Heated bed", at((bed[0], bed[1], bed[2] + 16))))
    out.append(("Bed", "Print sheet", at((bed[0], bed[1], bed[2] + 19))))
    for dx, dy in ((-100, -100), (100, -100), (-100, 100), (100, 100)):
        out.append(("Bed", "Bed spring", at((bed[0] + dx, bed[1] + dy, bed[2] + 4))))
        out.append(("Bed", "Levelling knob", at((bed[0] + dx, bed[1] + dy, bed[2] - 8))))

    head = (180, 180, 280)
    out.append(("Toolhead", "Carriage plate", at((head[0], head[1] + 25, head[2]))))
    out.append(("Toolhead", "Extruder", at((head[0], head[1] - 5, head[2] + 30))))
    out.append(("Toolhead", "Heatsink", at((head[0], head[1] - 5, head[2] - 6))))
    out.append(("Toolhead", "Heater block", at((head[0], head[1] - 5, head[2] - 17))))
    out.append(("Toolhead", "Nozzle", at((head[0], head[1] - 5, head[2] - 17), NZ)))
    out.append(("Toolhead", "Hotend fan", at((head[0], head[1] - 16, head[2] + 7), NY)))
    out.append(("Toolhead", "Part fan", at((head[0] + 40, head[1] - 5, head[2] - 10))))
    out.append(("Toolhead", "Fan shroud", at((head[0] - 30, head[1] - 5, head[2] - 20))))

    out.append(("Electronics", "Power supply", at((80, FRAME + 2, FOOT + 20))))
    out.append(("Electronics", "Board case", at((FRAME + 2, 40, FOOT + 20), X, Y)))
    out.append(("Electronics", "Main board", at((FRAME + 4, 47, FOOT + 22), X, Y)))
    out.append(("Electronics", "Display", at((135, -12, FOOT + 40))))
    out.append(("Electronics", "Display knob", at((240, -12, FOOT + 67))))
    out.append(("Electronics", "Power switch", at((FRAME - 40, FRAME + 2, FOOT + 130))))
    return out


def fasteners(count):
    """Screws and T-nuts along every face of every rail, spread over the rails before any rail fills up."""
    lanes = []
    for start, d, length in frame_rails():
        sides = [s for s in (X, NX, Y, NY, Z, NZ) if all(a * b == 0 for a, b in zip(s, d))]
        for n in sides:
            face = tuple(s + 10 * c for s, c in zip(start, n))
            lanes.append((face, d, n, int(length // 10)))
    out = []
    step = 0
    while len(out) < count:
        placed = False
        for face, d, n, slots in lanes:
            if step >= slots:
                continue
            placed = True
            pos = tuple(f + (step * 10 + 5) * c for f, c in zip(face, d))
            for part in ("M5 screw", "T-nut"):
                if len(out) < count:
                    out.append(("Fasteners", part, at(pos, n, d)))
        assert placed, f"the rails hold {len(out)} fasteners, not {count}"
        step += 1
    return out


def build(leaves):
    app = XCAFApp_Application.GetApplication_s()
    doc = TDocStd_Document(TCollection_ExtendedString("MDTV-XCAF"))
    app.NewDocument(TCollection_ExtendedString("MDTV-XCAF"), doc)
    # A document made in Python holds no XCAF tools until this.
    app.InitDocument(doc)
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())

    def named(label, name):
        TDataStd_Name.Set_s(label, TCollection_ExtendedString(name))
        return label

    labels = {}
    for name, (colour, shape) in parts().items():
        lab = named(st.AddShape(shape, False), name)
        ct.SetColor(lab, Quantity_Color(*colour, Quantity_TOC_RGB), XCAFDoc_ColorGen)
        labels[name] = lab

    base = layout()
    extra = leaves - len(base)
    assert extra >= 0, f"the printer has {len(base)} base parts, ask for at least that many leaves"
    placed = base + fasteners(extra)

    root = named(st.NewShape(), "Printer")
    groups = {}
    for group in ("Frame", "Motion", "Bed", "Toolhead", "Electronics"):
        groups[group] = named(st.NewShape(), group)
    if extra:
        groups["Fasteners"] = named(st.NewShape(), "Fasteners")
    for group, part, loc in placed:
        st.AddComponent(groups[group], labels[part], loc)
    for group in ("Frame", "Motion", "Bed", "Toolhead", "Electronics"):
        st.AddComponent(root, groups[group], TopLoc_Location())
    if extra:
        st.AddComponent(groups["Frame"], groups["Fasteners"], TopLoc_Location())
    st.UpdateAssemblies()

    bb = Bnd_Box()
    BRepBndLib.AddOptimal_s(XCAFDoc_ShapeTool.GetShape_s(root), bb, False, False)
    counts = {}
    for group, _, _ in placed:
        counts[group] = counts.get(group, 0) + 1
    motors = [loc.Transformation().TranslationPart() for _, part, loc in placed if part == "Stepper motor"]
    return doc, {
        "leaves": len(placed),
        "groups": counts,
        "bbox": [round(v, 3) for v in bb.Get()],
        "motors": [[round(p.X(), 3), round(p.Y(), 3), round(p.Z(), 3)] for p in motors],
    }


ENTITY = re.compile(r"^#(\d+) = ", re.M)
REF = re.compile(r"#(\d+)")


def canonical_styles(text):
    """OCCT writes the colour section in a hash order that changes from run to run. Renumbers it in the order of
    the shapes the styles point at; Part 21 allows forward references, so any numbering is valid."""
    head, data = text.split("DATA;\n", 1)
    data, tail = data.split("ENDSEC;\n", 1)
    starts = [m.start() for m in ENTITY.finditer(data)] + [len(data)]
    body = {int(ENTITY.match(data, a).group(1)): data[a:b] for a, b in zip(starts, starts[1:])}
    first = min(i for i, e in body.items() if "MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION" in e)
    styles = {i: e for i, e in body.items() if i >= first}
    assert not any(int(r) >= first for i, e in body.items() if i < first for r in REF.findall(e[e.index("=") :]))

    def target(i):
        refs = [int(r) for r in REF.findall(styles[i].split("(", 2)[2])]
        item = refs[0]
        return [int(r) for r in REF.findall(styles[item][styles[item].index("=") :])][-1], refs[-1]

    renumbered = {}

    def visit(i):
        if i < first or i in renumbered:
            return
        renumbered[i] = first + len(renumbered)
        for r in REF.findall(styles[i][styles[i].index("=") :]):
            visit(int(r))

    for i in sorted((i for i, e in styles.items() if "PRESENTATION_REPRESENTATION('" in e), key=target):
        visit(i)
    assert len(renumbered) == len(styles), "an entity in the colour section is not reached from a style"

    def swap(m):
        i = int(m.group(1))
        return f"#{renumbered.get(i, i)}"

    rest = [REF.sub(swap, e) for i, e in sorted(styles.items(), key=lambda kv: renumbered[kv[0]])]
    kept = "".join(e for i, e in sorted(body.items()) if i < first)
    return head + "DATA;\n" + kept + "".join(rest) + "ENDSEC;\n" + tail


def write(doc, out):
    Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
    w = STEPCAFControl_Writer()
    w.SetColorMode(True)
    w.SetNameMode(True)
    assert w.Transfer(doc, STEPControl_AsIs)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "printer.step")
        assert w.Write(path) == IFSelect_RetDone
        with open(path, encoding="ascii") as f:
            text = f.read()
    # The header holds the write time; a fixed one keeps a rerun byte for byte the same.
    text = re.sub(r"FILE_NAME\('[^']*','[^']*'", "FILE_NAME('printer','2026-01-01T00:00:00'", text, count=1)
    text = canonical_styles(text)
    with open(out, "wb") as f:
        f.write(gzip.compress(text.encode("ascii"), compresslevel=9, mtime=0))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--leaves", type=int, default=100)
    ap.add_argument("out")
    a = ap.parse_args()
    doc, facts = build(a.leaves)
    write(doc, a.out)
    print(json.dumps(facts))


if __name__ == "__main__":
    main()
