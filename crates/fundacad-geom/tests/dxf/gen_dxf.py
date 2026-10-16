"""Writes the DXF fixtures tests/import_dxf.rs reads, synthetic shapes only.

    pip install ezdxf==1.4.4
    python crates/fundacad-geom/tests/dxf/gen_dxf.py

dxf_shapes.dxf, R2010 ASCII, millimetres, one closed profile per layer:
  Plate   100 x 60 LWPOLYLINE with r5 bulge corners, a circle, two INSERTs of
          block HOLE (one rotated 33 degrees)
  Cam     two ARCs and two LINEs, line ends rounded to 6 decimals
  Mirror  an ARC with extrusion (0,0,-1) and a LINE
  Curves  a full ELLIPSE 20 x 10 at 30 degrees
  Spline  a clamped cubic SPLINE closed by a LINE
  Knots   a clamped cubic SPLINE with non uniform knots closed by a LINE
  Double  a cubic SPLINE with an interior double knot closed by a LINE
  Open    an unclamped uniform cubic SPLINE closed by a LINE
  Half    an elliptical arc 20 x 10 closed by a LINE
  plus TEXT, a DIMENSION and a HATCH, and a circle in paper space.
dxf_shapes_bin.dxf, the same drawing as binary DXF.
dxf_inch.dxf, $INSUNITS inch, a 1 x 2 rectangle.
dxf_r12.dxf, R12, the Plate outline as POLYLINE and VERTEX with bulges.
dxf_mesh.dxf, a 10 mm 3DFACE cube on layer Cube, a POLYFACE box on layer Poly,
  a MESH box on layer Mesh and one 3DSOLID.
The printed areas are what tests/import_dxf.rs expects, from ezdxf's own curve
evaluation.
"""
import math
import os

import ezdxf
from ezdxf.math import BSpline
from ezdxf.render import forms

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "tests", "fixtures")


def area(pts):
    return 0.5 * abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(pts, pts[1:] + pts[:1])))


def spline_layer(msp, layer, ctrl, knots):
    msp.add_open_spline(ctrl, degree=3, knots=knots, dxfattribs={"layer": layer})
    curve = BSpline(ctrl, order=4, knots=knots)
    a, b = curve.point(knots[3]), curve.point(knots[-4])
    msp.add_line(b, a, dxfattribs={"layer": layer})
    print(f"{layer} area {area([tuple(p)[:2] for p in curve.approximate(20000)]):.6f}")


def shapes():
    doc = ezdxf.new("R2010", setup=True)
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    r, b = 5.0, math.tan(math.radians(90) / 4)
    pts = [(r, 0, b * 0), (100 - r, 0, b), (100, r, 0), (100, 60 - r, b), (100 - r, 60, 0), (r, 60, b), (0, 60 - r, 0), (0, r, b)]
    msp.add_lwpolyline([(x, y, 0, 0, bb) for x, y, bb in pts], format="xyseb", close=True, dxfattribs={"layer": "Plate"})
    msp.add_circle((20, 30), 8, dxfattribs={"layer": "Plate"})
    blk = doc.blocks.new("HOLE", base_point=(1, 1))
    blk.add_circle((1, 1), 3, dxfattribs={"layer": "0"})
    msp.add_blockref("HOLE", (60, 30), dxfattribs={"layer": "Plate"})
    msp.add_blockref("HOLE", (80, 30), dxfattribs={"layer": "Plate", "rotation": 33})

    c1, c2, R1, R2 = (0, 100), (40, 100), 15.0, 8.0
    t1 = math.degrees(math.pi / 2 + math.asin((R1 - R2) / 40))
    p = lambda c, R, deg: (round(c[0] + R * math.cos(math.radians(deg)), 6), round(c[1] + R * math.sin(math.radians(deg)), 6))
    msp.add_arc(c1, R1, t1, -t1, dxfattribs={"layer": "Cam"})
    msp.add_arc(c2, R2, -t1, t1, dxfattribs={"layer": "Cam"})
    msp.add_line(p(c1, R1, t1), p(c2, R2, t1), dxfattribs={"layer": "Cam"})
    msp.add_line(p(c1, R1, -t1), p(c2, R2, -t1), dxfattribs={"layer": "Cam"})

    msp.add_arc((120, 30), 10, 270, 90, dxfattribs={"layer": "Mirror", "extrusion": (0, 0, -1)})
    msp.add_line((-120, 40), (-120, 20), dxfattribs={"layer": "Mirror"})

    rot = math.radians(30)
    msp.add_ellipse((150, 30), major_axis=(20 * math.cos(rot), 20 * math.sin(rot)), ratio=0.5, dxfattribs={"layer": "Curves"})

    msp.add_open_spline([(200, 0), (210, 20), (230, 25), (250, 0)], degree=3, dxfattribs={"layer": "Spline"})
    msp.add_line((250, 0), (200, 0), dxfattribs={"layer": "Spline"})

    spline_layer(msp, "Knots", [(0, -50), (5, -30), (20, -25), (35, -40), (45, -20), (60, -50)], [0, 0, 0, 0, 1, 3, 4, 4, 4, 4])
    spline_layer(msp, "Double", [(0, -100), (10, -80), (25, -75), (40, -90), (50, -70), (60, -100)], [0, 0, 0, 0, 2, 2, 4, 4, 4, 4])
    spline_layer(msp, "Open", [(100, -100), (105, -80), (120, -70), (140, -75), (150, -90), (160, -100)], list(range(10)))

    msp.add_ellipse((200, -60), major_axis=(20, 0), ratio=0.5, start_param=0, end_param=math.pi, dxfattribs={"layer": "Half"})
    msp.add_line((180, -60), (220, -60), dxfattribs={"layer": "Half"})

    msp.add_text("FundaCAD", dxfattribs={"layer": "Notes", "height": 5}).set_placement((0, 120))
    msp.add_linear_dim(base=(0, -10), p1=(0, 0), p2=(100, 0), dxfattribs={"layer": "Notes"}).render()
    hatch = msp.add_hatch(dxfattribs={"layer": "Notes"})
    hatch.paths.add_polyline_path([(0, 130), (10, 130), (10, 140)], is_closed=True)
    doc.paperspace().add_circle((50, 50), 20, dxfattribs={"layer": "Paper"})

    doc.saveas(os.path.join(OUT, "dxf_shapes.dxf"))
    doc.saveas(os.path.join(OUT, "dxf_shapes_bin.dxf"), fmt="bin")


def inch():
    doc = ezdxf.new("R2010", setup=False)
    doc.header["$INSUNITS"] = 1
    doc.modelspace().add_lwpolyline([(0, 0), (1, 0), (1, 2), (0, 2)], close=True, dxfattribs={"layer": "Inch"})
    doc.saveas(os.path.join(OUT, "dxf_inch.dxf"))


def r12():
    doc = ezdxf.new("R12", setup=False)
    r, b = 5.0, math.tan(math.radians(90) / 4)
    pts = [(r, 0, 0), (100 - r, 0, b), (100, r, 0), (100, 60 - r, b), (100 - r, 60, 0), (r, 60, b), (0, 60 - r, 0), (0, r, b)]
    doc.modelspace().add_polyline2d(pts, format="xyb", close=True, dxfattribs={"layer": "Outline"})
    doc.saveas(os.path.join(OUT, "dxf_r12.dxf"))


def mesh():
    doc = ezdxf.new("R2010", setup=False)
    doc.header["$INSUNITS"] = 4
    msp = doc.modelspace()
    s = 10.0
    v = [(0, 0, 0), (s, 0, 0), (s, s, 0), (0, s, 0), (0, 0, s), (s, 0, s), (s, s, s), (0, s, s)]
    quads = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    for q in quads:
        msp.add_3dface([v[i] for i in q], dxfattribs={"layer": "Cube"})
    poly = msp.add_polyface(dxfattribs={"layer": "Poly"})
    for q in quads:
        poly.append_face([(x + 20, y, z) for x, y, z in (v[i] for i in q)])
    poly.optimize()
    box = forms.cube().scale_uniform(s).translate(45, 5, 5)
    box.render_mesh(msp, dxfattribs={"layer": "Mesh"})
    solid = msp.add_3dsolid(dxfattribs={"layer": "Solid"})
    solid.sat = ["700 0 1 0", "@8 FundaCAD 0 0", "End-of-ACIS-data"]
    doc.saveas(os.path.join(OUT, "dxf_mesh.dxf"))


shapes()
inch()
r12()
mesh()
