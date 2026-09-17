"""Expected results for the Rust builder, measured on the Python builder.

Runs sidecar/builder.py `rebuild` over every document in CASES and writes
fixtures.json: per body its id, name, volume and exact bounding box, the error
list in the wire shape of server.py `_err_wire`, the resulting bodyIds map and
the datum plane registry. crates/fundacad-geom/tests/builder_parity.rs rebuilds
the same documents in Rust and compares.

Run from the repository root:
    sidecar/.venv/Scripts/python.exe crates/fundacad-geom/tests/builder/gen_fixtures.py
"""

import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SIDECAR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "sidecar"))
sys.path.insert(0, SIDECAR)
os.environ.setdefault("FUNDACAD_DISK_CACHE", "0")

import builder  # noqa: E402
from OCP.Bnd import Bnd_Box  # noqa: E402
from OCP.BRepBndLib import BRepBndLib  # noqa: E402
from OCP.BRepGProp import BRepGProp  # noqa: E402
from OCP.GProp import GProp_GProps  # noqa: E402
from defeature import _face_fp  # noqa: E402


def sk(fid, entities, plane="XY", **extra):
    f = {"id": fid, "type": "sketch", "plane": plane, "entities": entities}
    f.update(extra)
    return f


def rect(w, h, x=0, y=0, **extra):
    e = {"type": "rectangle", "width": w, "height": h, "x": x, "y": y}
    e.update(extra)
    return e


def circle(r, x=0, y=0, **extra):
    e = {"type": "circle", "radius": r, "x": x, "y": y}
    e.update(extra)
    return e


def line(x1, y1, x2, y2):
    return {"type": "line", "x1": x1, "y1": y1, "x2": x2, "y2": y2}


def ext(fid, sketch, distance, operation="new", **extra):
    f = {"id": fid, "type": "extrude", "sketch": sketch, "distance": distance,
         "operation": operation}
    f.update(extra)
    return f


def box(fid, l, w, h, **extra):
    f = {"id": fid, "type": "box", "length": l, "width": w, "height": h}
    f.update(extra)
    return f


def doc(features, parameters=None, **extra):
    d = {"parameters": parameters or {}, "features": features}
    d.update(extra)
    return d


HOLE_BASE = [sk("s1", [rect(40, 40)]), ext("e1", "s1", 20)]
HOLE_SK = sk("s2", [{"type": "point", "x": -8, "y": 0}, {"type": "point", "x": 8, "y": 0}],
             plane={"origin": [0, 0, 20], "normal": [0, 0, 1], "xdir": [1, 0, 0]})


def hole(**kw):
    f = {"id": "h", "type": "hole", "sketch": "s2"}
    f.update(kw)
    return f


CASES = {
    # primitives
    "box": doc([box("b", 20, 10, 5)]),
    "cylinder": doc([{"id": "c", "type": "cylinder", "radius": 4, "height": 12}]),
    "sphere": doc([{"id": "s", "type": "sphere", "radius": 7}]),
    "cone_frustum": doc([{"id": "c", "type": "cone", "bottomRadius": 5, "topRadius": 2, "height": 10}]),
    "cone_point": doc([{"id": "c", "type": "cone", "bottomRadius": 0, "topRadius": 4, "height": 6}]),
    "torus": doc([{"id": "t", "type": "torus", "majorRadius": 10, "minorRadius": 2.5}]),
    "box_param": doc([box("b", "L", 10, "H")], {"L": 30, "H": 2.5}),
    "box_zero": doc([box("b", 0, 10, 5)]),
    "box_negative": doc([box("b", 10, -2.5, 5)]),
    "box_unresolved": doc([box("b", "nope", 10, 5)]),
    "box_missing_field": doc([{"id": "b", "type": "box", "length": 5, "width": 5}]),
    "cone_equal": doc([{"id": "c", "type": "cone", "bottomRadius": 3, "topRadius": 3, "height": 4}]),
    "cone_negative": doc([{"id": "c", "type": "cone", "bottomRadius": -1, "topRadius": 3, "height": 4}]),
    "torus_fat": doc([{"id": "t", "type": "torus", "majorRadius": 2, "minorRadius": 3}]),
    "sphere_small_value": doc([{"id": "s", "type": "sphere", "radius": -0.0001}]),
    "two_boxes": doc([box("a", 10, 10, 10), box("b", 4, 4, 4)]),
    "box_join": doc([box("a", 10, 10, 10), box("b", 4, 4, 20, operation="join")]),
    "box_cut": doc([box("a", 10, 10, 10), {"id": "c", "type": "cylinder", "radius": 2, "height": 20, "operation": "cut"}]),
    "box_intersect": doc([box("a", 10, 10, 10), {"id": "s", "type": "sphere", "radius": 6.5, "operation": "intersect"}]),
    "cut_misses": doc([box("a", 10, 10, 10), box("m", 2, 2, 2, operation="cut"),
                       {"id": "mv", "type": "move", "dx": 50}]),
    "join_targets_missing": doc([box("a", 10, 10, 10), box("b", 4, 4, 4, operation="join", targets=["body9"])]),
    "cut_everything": doc([box("a", 4, 4, 4), box("b", 10, 10, 10, operation="cut")]),
    # transforms
    "move": doc([box("a", 10, 4, 2), {"id": "m", "type": "move", "dx": 5, "dy": -3, "dz": 7, "rx": 30, "ry": 10, "rz": 45}]),
    "move_param": doc([box("a", 10, 4, 2), {"id": "m", "type": "move", "dz": "lift"}], {"lift": 12.5}),
    "move_stale": doc([box("a", 10, 4, 2), {"id": "m", "type": "move", "dx": 5, "bodies": ["body7"]}]),
    "move_nothing": doc([{"id": "m", "type": "move", "dx": 5}]),
    "scale_uniform": doc([box("a", 10, 4, 2), {"id": "s", "type": "scale", "factor": 2}]),
    "scale_axes_about": doc([box("a", 10, 4, 2), {"id": "s", "type": "scale", "factor": 1, "sx": 2, "sz": 3, "about": [5, 0, 1]}]),
    "scale_after_move": doc([box("a", 10, 4, 2), {"id": "m", "type": "move", "dx": 20}, {"id": "s", "type": "scale", "factor": 2}]),
    "scale_zero": doc([box("a", 10, 4, 2), {"id": "s", "type": "scale", "factor": 1, "sy": 0}]),
    "mirror_yz": doc([box("a", 10, 4, 2), {"id": "m", "type": "move", "dx": 8}, {"id": "mi", "type": "mirror", "plane": "YZ"}]),
    "mirror_xz": doc([box("a", 10, 4, 2), {"id": "m", "type": "move", "dy": 1}, {"id": "mi", "type": "mirror", "plane": "XZ"}]),
    "mirror_datum": doc([{"id": "p", "type": "datumPlane", "plane": "YZ", "offset": 12}, box("a", 10, 4, 2),
                         {"id": "mi", "type": "mirror", "plane": "p"}]),
    "mirror_datum_tilted": doc([{"id": "p", "type": "datumPlane", "plane": {"origin": [8, 0, 0], "normal": [1, 1, 0], "xdir": [0, 0, 1]}},
                                box("a", 4, 4, 4), {"id": "mi", "type": "mirror", "plane": "p"}]),
    "mirror_through_body": doc([box("a", 10, 4, 2), {"id": "m", "type": "move", "dx": 3}, {"id": "mi", "type": "mirror", "plane": "YZ"}]),
    "mirror_unknown_plane": doc([box("a", 10, 4, 2), {"id": "mi", "type": "mirror", "plane": "nope"}]),
    "mirror_nothing": doc([{"id": "mi", "type": "mirror", "plane": "XY"}]),
    "duplicate": doc([box("a", 10, 4, 2), {"id": "d", "type": "duplicate", "dx": 30, "rz": 90}]),
    "duplicate_two": doc([box("a", 10, 4, 2), box("b", 1, 1, 1), {"id": "d", "type": "duplicate", "bodies": ["body1", "body2"], "dz": 10}]),
    "remove_body": doc([box("a", 10, 4, 2), box("b", 1, 1, 1), {"id": "r", "type": "removeBody", "bodies": ["body1"]}]),
    "remove_missing": doc([box("a", 10, 4, 2), {"id": "r", "type": "removeBody", "bodies": ["body5", "body3"]}]),
    # datums
    "datum_offset": doc([
        {"id": "p", "type": "datumPlane", "plane": "XY", "offset": 15},
        sk("s", [rect(10, 10)], planeId="p"),
        ext("e", "s", 5),
    ]),
    "datum_named_xz": doc([
        {"id": "p", "type": "datumPlane", "plane": "XZ", "offset": -4},
        {"id": "q", "type": "datumPlane", "plane": "p", "offset": 2},
        sk("s", [rect(6, 3, x=2, y=1)], plane="XZ", planeId="q"),
        ext("e", "s", 5),
    ]),
    "datum_custom": doc([
        {"id": "p", "type": "datumPlane", "plane": {"origin": [1, 2, 3], "normal": [0, 0.6, 0.8], "xdir": [1, 0, 0]}, "offset": 1},
        sk("s", [circle(3)], planeId="p"),
        ext("e", "s", 4),
    ]),
    "datum_bad": doc([{"id": "p", "type": "datumPlane", "plane": "ZZ"}]),
    # sketches and extrude
    "rect_extrude": doc([sk("s", [rect(20, 10, x=5, y=-2)]), ext("e", "s", 8)]),
    "rect_angle": doc([sk("s", [rect(20, 10, angle=30)]), ext("e", "s", 3)]),
    "circle_yz": doc([sk("s", [circle(5, x=3, y=4)], plane="YZ"), ext("e", "s", 10)]),
    "circle_xz_negative": doc([sk("s", [circle(5)], plane="XZ"), ext("e", "s", -6)]),
    "extrude_symmetric": doc([sk("s", [rect(10, 10)]), ext("e", "s", 4, symmetric=True)]),
    "extrude_param": doc([sk("s", [rect(10, "W")]), ext("e", "s", "D")], {"W": 7, "D": 3.5}),
    "extrude_zero": doc([sk("s", [rect(10, 10)]), ext("e", "s", 0)]),
    "extrude_missing_sketch": doc([ext("e", "s9", 5)]),
    "extrude_empty_sketch": doc([sk("s", [{"type": "point", "x": 1, "y": 1}]), ext("e", "s", 5)]),
    "ring_whole": doc([sk("s", [rect(20, 20), circle(4)]), ext("e", "s", 5)]),
    "ring_region": doc([sk("s", [rect(20, 20), circle(4)]), ext("e", "s", 5, regions=[[8, 8, 0]])]),
    "disk_region": doc([sk("s", [rect(20, 20), circle(4)]), ext("e", "s", 5, region=[0, 0, 0])]),
    "two_regions": doc([sk("s", [rect(20, 20), circle(4), circle(2, x=6, y=6)]),
                        ext("e", "s", 5, regions=[[0, 0, 0], [6, 6, 0]])]),
    "nested_holes": doc([sk("s", [circle(10), circle(6), circle(3)]), ext("e", "s", 2, regions=[[8, 0, 0], [0, 0, 0]])]),
    "zero_circle": doc([sk("s", [rect(10, 10), circle(0)]), ext("e", "s", 5)]),
    "zero_rect": doc([sk("s", [rect(0, 10)])]),
    "triangle_lines": doc([sk("s", [line(0, 0, 10, 0), line(10, 0, 0, 8), line(0, 8, 0, 0)]), ext("e", "s", 2)]),
    "clockwise_lines": doc([sk("s", [line(0, 0, 0, 8), line(0, 8, 10, 8), line(10, 8, 10, 0), line(10, 0, 0, 0)]), ext("e", "s", 3)]),
    "arc_d": doc([sk("s", [line(0, -5, 0, 5), {"type": "arc", "x1": 0, "y1": 5, "x2": 0, "y2": -5, "mx": 5, "my": 0}]), ext("e", "s", 2)]),
    "polygon": doc([sk("s", [{"type": "polygon", "x": 1, "y": 2, "radius": 6, "sides": 6, "angle": 15}]), ext("e", "s", 2)]),
    "slot": doc([sk("s", [{"type": "slot", "x1": -5, "y1": 0, "x2": 5, "y2": 3, "width": 4}], plane="XZ"), ext("e", "s", 2)]),
    "ellipse": doc([sk("s", [{"type": "ellipse", "rx": 3, "ry": 7, "x": 2, "angle": 20}]), ext("e", "s", 2)]),
    "spline": doc([sk("s", [{"type": "spline", "points": [{"x": 0, "y": 0}, {"x": 4, "y": 3}, {"x": 8, "y": 1}, {"x": 12, "y": 0}]},
                            line(12, 0, 0, 0)]), ext("e", "s", 2)]),
    "crossing_lines": doc([sk("s", [rect(10, 10), line(-8, 0, 8, 0)]), ext("e", "s", 2, regions=[[0, 3, 0]])]),
    "construction_skipped": doc([sk("s", [rect(10, 10), circle(3, construction=True)]), ext("e", "s", 2)]),
    "sketch_on_plane_def": doc([sk("s", [rect(4, 6)], plane={"origin": [0, 0, 10], "normal": [1, 1, 0], "xdir": [0, 0, 1]}), ext("e", "s", 5)]),
    "pattern_rect": doc([sk("s", [rect(40, 40), {"id": "h", "type": "circle", "radius": 2, "x": -10, "y": -10}],
                            patterns=[{"id": "p", "type": "patternRect", "sources": ["h"], "countX": 3, "countY": 2, "spacingX": 10, "spacingY": 12}]),
                         ext("e", "s", 3, regions=[[15, 15, 0]])]),
    "bolt_circle": doc([sk("s", [circle(20)], patterns=[{"id": "b", "type": "boltCircle", "cx": 0, "cy": 0, "bcd": 24, "count": 6, "diameter": 3}]),
                        ext("e", "s", 3, regions=[[0, 0, 0]])]),
    "extrude_cut": doc([box("a", 30, 30, 10), sk("s", [circle(4)]), ext("e", "s", 20, "cut", symmetric=True)]),
    "extrude_join": doc([box("a", 30, 30, 10), sk("s", [rect(10, 10)], plane={"origin": [0, 0, 5], "normal": [0, 0, 1], "xdir": [1, 0, 0]}), ext("e", "s", 6, "join")]),
    "extrude_join_inside": doc([box("a", 30, 30, 10), sk("s", [rect(10, 10)]), ext("e", "s", 2, "join")]),
    "extrude_intersect": doc([box("a", 30, 30, 10), sk("s", [circle(6)]), ext("e", "s", 3, "intersect")]),
    "extrude_hidden": doc([box("a", 30, 30, 10), sk("s", [circle(4)]), ext("e", "s", 20, "cut", hiddenBodies=["body1"])]),
    "extrude_taper": doc([sk("s", [rect(20, 20)]), ext("e", "s", 5, taper=10)]),
    "extrude_taper_negative": doc([sk("s", [rect(20, 20)]), ext("e", "s", 5, taper=-10)]),
    "extrude_taper_bad": doc([sk("s", [rect(20, 20)]), ext("e", "s", 5, taper=95)]),
    "extrude_on_datum_cut_two_bodies": doc([
        box("a", 10, 10, 10), box("b", 10, 10, 10), {"id": "m", "type": "move", "dx": 12, "bodies": ["body2"]},
        sk("s", [rect(30, 2, x=6)]), ext("e", "s", 20, "cut", symmetric=True),
    ]),
    # boolean feature
    "boolean_union": doc([box("a", 10, 10, 10), box("b", 10, 10, 10), {"id": "m", "type": "move", "dx": 5, "bodies": ["body2"]},
                          {"id": "u", "type": "boolean", "operation": "union", "target": "body1", "tools": ["body2"]}]),
    "boolean_subtract_keep": doc([box("a", 10, 10, 10), {"id": "c", "type": "cylinder", "radius": 3, "height": 30},
                                  {"id": "u", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"], "keepOriginals": True}]),
    "boolean_intersect": doc([box("a", 10, 10, 10), {"id": "s", "type": "sphere", "radius": 6},
                              {"id": "u", "type": "boolean", "operation": "intersect", "target": "body1", "tools": ["body2"]}]),
    "boolean_subtract_nothing": doc([box("a", 10, 10, 10), box("b", 2, 2, 2), {"id": "m", "type": "move", "dx": 40, "bodies": ["body2"]},
                                     {"id": "u", "type": "boolean", "operation": "subtract", "target": "body1", "tools": ["body2"]}]),
    "boolean_stale": doc([box("a", 10, 10, 10), {"id": "u", "type": "boolean", "operation": "union", "target": "body4", "tools": ["body1"]}]),
    "boolean_bad_op": doc([box("a", 10, 10, 10), box("b", 1, 1, 1), {"id": "u", "type": "boolean", "operation": "xor", "target": "body1"}]),
    # revolve
    "revolve_full": doc([sk("s", [rect(4, 10, x=8, y=0)], plane="XZ"), {"id": "r", "type": "revolve", "sketch": "s", "axis": "Z", "angle": 360}]),
    "revolve_quarter": doc([sk("s", [rect(4, 10, x=8, y=0)], plane="XZ"), {"id": "r", "type": "revolve", "sketch": "s", "axis": "Z", "angle": 90}]),
    "revolve_zero": doc([sk("s", [rect(4, 10, x=8, y=0)], plane="XZ"), {"id": "r", "type": "revolve", "sketch": "s", "axis": "Z", "angle": 0}]),
    # body patterns
    "pattern_linear_apart": doc([box("a", 10, 10, 10), {"id": "p", "type": "patternLinear", "count": 3, "spacing": 15, "axis": "Y"}]),
    "pattern_linear_overlap": doc([box("a", 10, 10, 10), {"id": "p", "type": "patternLinear", "count": 3, "spacing": 6, "axis": "X"}]),
    "pattern_linear_touching": doc([box("a", 10, 10, 10), {"id": "p", "type": "patternLinear", "count": 2, "spacing": 10}]),
    "pattern_linear_default_axis_round": doc([box("a", 2, 2, 2), {"id": "p", "type": "patternLinear", "count": 2.5, "spacing": "gap", "axis": "Z"}], {"gap": 4}),
    "pattern_linear_zero": doc([box("a", 2, 2, 2), {"id": "p", "type": "patternLinear", "count": 0, "spacing": 4}]),
    "pattern_linear_nothing": doc([{"id": "p", "type": "patternLinear", "count": 3, "spacing": 4}]),
    "pattern_linear_bodies": doc([box("a", 2, 2, 2), box("b", 3, 3, 3), {"id": "m", "type": "move", "dx": 20, "bodies": ["body2"]},
                                  {"id": "p", "type": "patternLinear", "count": 2, "spacing": 5, "axis": "Y", "bodies": ["body1", "body9", "body2"]}]),
    "pattern_circular_full": doc([box("a", 4, 4, 4), {"id": "m", "type": "move", "dx": 10}, {"id": "p", "type": "patternCircular", "count": 5, "angle": 360}]),
    "pattern_circular_partial_x": doc([box("a", 4, 4, 4), {"id": "m", "type": "move", "dy": 10}, {"id": "p", "type": "patternCircular", "count": 4, "angle": 90, "axis": "X"}]),
    "pattern_circular_overlap": doc([box("a", 10, 10, 4), {"id": "m", "type": "move", "dx": 4}, {"id": "p", "type": "patternCircular", "count": 6, "angle": 360, "axis": "Z"}]),
    "pattern_circular_one": doc([box("a", 4, 4, 4), {"id": "p", "type": "patternCircular", "count": 1, "angle": 180, "axis": "Y"}]),
    "pattern_circular_negative": doc([box("a", 4, 4, 4), {"id": "p", "type": "patternCircular", "count": -2, "angle": 180}]),
    "pattern_rect_grid": doc([box("a", 4, 4, 4), {"id": "p", "type": "patternRect", "countX": 3, "countY": 2, "spacingX": 10, "spacingY": 7}]),
    "pattern_rect_overlap": doc([box("a", 4, 4, 4), {"id": "p", "type": "patternRect", "countX": 2, "countY": 2, "spacingX": 3, "spacingY": 3}]),
    "pattern_rect_zero": doc([box("a", 4, 4, 4), {"id": "p", "type": "patternRect", "countX": 2, "countY": 0, "spacingX": 3, "spacingY": 3}]),
    "pattern_rect_nothing": doc([{"id": "p", "type": "patternRect", "countX": 2, "countY": 2, "spacingX": 3, "spacingY": 3}]),
    # hole, positioned by a sketch (the face selector form waits on selectors)
    "hole_sketch_points": doc(HOLE_BASE + [HOLE_SK, hole(diameter=3, depth=4)]),
    "hole_sketch_circles": doc(HOLE_BASE + [dict(HOLE_SK, entities=[circle(1, 0, 12), circle(2, -10, -10, construction=True)]), hole(diameter=3, depth=4)]),
    "hole_through_drill_point_ignored": doc(HOLE_BASE + [HOLE_SK, hole(diameter=4, extent="through", drillPoint=True)]),
    "hole_drill_point": doc(HOLE_BASE + [HOLE_SK, hole(diameter=4, depth=8, drillPoint=True)]),
    "hole_default_depth_param": doc(HOLE_BASE + [HOLE_SK, hole(diameter="D")], {"D": 2.5}),
    "hole_counterbore_standard": doc(HOLE_BASE + [HOLE_SK, hole(holeType="counterbore", size="M3", extent="through")]),
    "hole_counterbore_custom": doc(HOLE_BASE + [HOLE_SK, hole(holeType="counterbore", diameter=3.4, depth=12, cbDiameter=6.5, cbDepth=3.4)]),
    "hole_countersink_standard": doc(HOLE_BASE + [HOLE_SK, hole(holeType="countersink", size="M4", fit="close", extent="through")]),
    "hole_countersink_angle": doc(HOLE_BASE + [HOLE_SK, hole(holeType="countersink", diameter=3, depth=10, csDiameter=6, csAngle=120)]),
    "hole_insert_standard": doc(HOLE_BASE + [HOLE_SK, hole(holeType="insert", size="M3", extent="through")]),
    "hole_insert_no_lead": doc(HOLE_BASE + [HOLE_SK, hole(holeType="insert", diameter=4, depth=5, leadIn=0)]),
    "hole_tap": doc(HOLE_BASE + [HOLE_SK, hole(standard="tap", size="M5", depth=6)]),
    "hole_points_and_sketch": doc(HOLE_BASE + [HOLE_SK, hole(diameter=2, depth=3, points=[[5, 5, 99]])]),
    "hole_flip": doc(HOLE_BASE + [dict(HOLE_SK, plane={"origin": [0, 0, 0], "normal": [0, 0, -1], "xdir": [1, 0, 0]}), hole(diameter=3, depth=4, flip=True)]),
    "hole_side_plane": doc(HOLE_BASE + [sk("s2", [{"type": "point", "x": 10, "y": 5}], plane={"origin": [20, 0, 0], "normal": [1, 0, 0], "xdir": [0, 1, 0]}),
                                        hole(diameter=4, depth=10)]),
    "hole_nearest_body": doc(HOLE_BASE + [box("b2", 10, 10, 10), {"id": "m", "type": "move", "dx": 60, "dz": 15, "bodies": ["body2"]}, HOLE_SK, hole(diameter=3, depth=4)]),
    "hole_named_body": doc(HOLE_BASE + [box("b2", 10, 10, 10), HOLE_SK, hole(diameter=3, depth=4, body="body1")]),
    "hole_misses": doc(HOLE_BASE + [sk("s2", [{"type": "point", "x": 100, "y": 0}], plane={"origin": [0, 0, 20], "normal": [0, 0, 1], "xdir": [1, 0, 0]}), hole(diameter=3, depth=4)]),
    "hole_removes_body": doc([box("a", 2, 2, 2), sk("s2", [{"type": "point", "x": 0, "y": 0}], plane={"origin": [0, 0, 1], "normal": [0, 0, 1], "xdir": [1, 0, 0]}), hole(diameter=10, extent="through")]),
    "hole_unknown_type": doc(HOLE_BASE + [HOLE_SK, hole(holeType="tapered", diameter=3)]),
    "hole_unknown_size": doc(HOLE_BASE + [HOLE_SK, hole(diameter=4, size="M7")]),
    "hole_no_diameter": doc(HOLE_BASE + [HOLE_SK, hole()]),
    "hole_insert_no_preset": doc(HOLE_BASE + [HOLE_SK, hole(holeType="insert", size="M8")]),
    "hole_zero_diameter": doc(HOLE_BASE + [HOLE_SK, hole(diameter=0)]),
    "hole_negative_depth": doc(HOLE_BASE + [HOLE_SK, hole(diameter=3, depth=-1.5)]),
    "hole_counterbore_missing": doc(HOLE_BASE + [HOLE_SK, hole(holeType="counterbore", diameter=4, cbDiameter=8)]),
    "hole_counterbore_small": doc(HOLE_BASE + [HOLE_SK, hole(holeType="counterbore", diameter=4, cbDiameter=3, cbDepth=2)]),
    "hole_counterbore_deep": doc(HOLE_BASE + [HOLE_SK, hole(holeType="counterbore", diameter=4, depth=5, cbDiameter=8, cbDepth=5)]),
    "hole_countersink_missing": doc(HOLE_BASE + [HOLE_SK, hole(holeType="countersink", diameter=4)]),
    "hole_countersink_small": doc(HOLE_BASE + [HOLE_SK, hole(holeType="countersink", diameter=4, csDiameter=4)]),
    "hole_countersink_angle_bad": doc(HOLE_BASE + [HOLE_SK, hole(holeType="countersink", diameter=4, csDiameter=8, csAngle=180)]),
    "hole_countersink_deep": doc(HOLE_BASE + [HOLE_SK, hole(holeType="countersink", diameter=2, depth=1, csDiameter=8)]),
    "hole_lead_negative": doc(HOLE_BASE + [HOLE_SK, hole(holeType="insert", diameter=4, leadIn=-0.5)]),
    "hole_lead_deep": doc(HOLE_BASE + [HOLE_SK, hole(holeType="insert", diameter=4, depth=1, leadIn=2)]),
    "hole_missing_sketch": doc(HOLE_BASE + [hole(diameter=3, sketch="s9")]),
    "hole_no_positions": doc(HOLE_BASE + [sk("s2", [rect(4, 4)]), hole(diameter=3)]),
    "hole_no_plane": doc(HOLE_BASE + [{"id": "h", "type": "hole", "points": [[0, 0, 20]], "diameter": 3}]),
    "hole_no_body": doc([HOLE_SK, hole(diameter=3)]),
    "hole_body_gone": doc(HOLE_BASE + [HOLE_SK, hole(diameter=3, body="body4")]),
    # loft
    "loft_rects": doc([sk("a", [rect(20, 20)]), sk("b", [rect(10, 10, x=2)], plane={"origin": [0, 0, 20], "normal": [0, 0, 1], "xdir": [1, 0, 0]}),
                       {"id": "l", "type": "loft", "sketches": ["a", "b"]}]),
    "loft_rect_to_circle_three": doc([sk("a", [rect(20, 20)]), sk("b", [circle(8)], plane={"origin": [0, 0, 15], "normal": [0, 0, 1], "xdir": [1, 0, 0]}),
                                      sk("c", [circle(4)], plane={"origin": [0, 0, 30], "normal": [0, 0, 1], "xdir": [1, 0, 0]}),
                                      {"id": "l", "type": "loft", "sketches": ["a", "b", "c"], "operation": "new"}]),
    "loft_profiles_rings": doc([sk("a", [circle(10), circle(5)]), sk("b", [circle(6), circle(3)], plane={"origin": [0, 0, 12], "normal": [0, 0, 1], "xdir": [1, 0, 0]}),
                                {"id": "l", "type": "loft", "profiles": [{"sketch": "a", "region": [7, 0, 0]}, {"sketch": "b", "region": [4.5, 0, 12]}]}]),
    "loft_profiles_disk": doc([sk("a", [circle(10), circle(5)]), sk("b", [rect(6, 6)], plane={"origin": [0, 0, 12], "normal": [0, 0, 1], "xdir": [1, 0, 0]}),
                               {"id": "l", "type": "loft", "profiles": [{"sketch": "a", "region": [0, 0, 0]}, {"sketch": "b", "region": [0, 0, 12]}]}]),
    "loft_join": doc([box("x", 30, 30, 10), sk("a", [rect(10, 10)], plane={"origin": [0, 0, 4], "normal": [0, 0, 1], "xdir": [1, 0, 0]}),
                      sk("b", [circle(3)], plane={"origin": [0, 0, 20], "normal": [0, 0, 1], "xdir": [1, 0, 0]}),
                      {"id": "l", "type": "loft", "sketches": ["a", "b"], "operation": "join"}]),
    "loft_one": doc([sk("a", [rect(20, 20)]), {"id": "l", "type": "loft", "sketches": ["a"]}]),
    "loft_none": doc([{"id": "l", "type": "loft"}]),
    "loft_missing_sketch": doc([sk("a", [rect(20, 20)]), {"id": "l", "type": "loft", "sketches": ["a", "zz"]}]),
    "loft_open_profile": doc([sk("a", [rect(20, 20)]), sk("b", [line(0, 0, 5, 5)]),
                              {"id": "l", "type": "loft", "profiles": [{"sketch": "a", "region": [0, 0, 0]}, {"sketch": "b", "region": [0, 0, 0]}]}]),
    "loft_hole_mismatch": doc([sk("a", [circle(10), circle(5)]), sk("b", [circle(6)], plane={"origin": [0, 0, 12], "normal": [0, 0, 1], "xdir": [1, 0, 0]}),
                               {"id": "l", "type": "loft", "profiles": [{"sketch": "a", "region": [7, 0, 0]}, {"sketch": "b", "region": [0, 0, 12]}]}]),
    "loft_coincident": doc([sk("a", [rect(20, 20)]), sk("b", [rect(20, 20)]), {"id": "l", "type": "loft", "sketches": ["a", "b"]}]),
    # sweep
    "sweep_line": doc([sk("p", [circle(2)]), sk("q", [line(0, 0, 0, 30)], plane="XZ"),
                       {"id": "w", "type": "sweep", "profile": "p", "path": "q", "operation": "new"}]),
    "sweep_corner": doc([sk("p", [rect(4, 4)]), sk("q", [line(0, 0, 0, 20), line(0, 20, 15, 20)], plane="XZ"),
                         {"id": "w", "type": "sweep", "profile": "p", "path": "q"}]),
    "sweep_arc_ring": doc([sk("p", [circle(3), circle(1.5)]), sk("q", [{"type": "arc", "x1": 0, "y1": 0, "x2": 20, "y2": 20, "mx": 5.857864, "my": 14.142136}], plane="XZ"),
                           {"id": "w", "type": "sweep", "profile": "p", "path": "q", "operation": "new"}]),
    "sweep_gap_stitched": doc([sk("p", [circle(1)]), sk("q", [line(0, 0, 0, 10), line(0.0001, 10, 10, 10)], plane="XZ"),
                               {"id": "w", "type": "sweep", "profile": "p", "path": "q", "operation": "new"}]),
    "sweep_cut": doc([box("x", 40, 40, 10), sk("p", [circle(2)], plane={"origin": [-30, 0, 5], "normal": [1, 0, 0], "xdir": [0, 1, 0]}),
                      sk("q", [line(-30, 5, 30, 5)], plane="XZ"),
                      {"id": "w", "type": "sweep", "profile": "p", "path": "q", "operation": "cut"}]),
    "sweep_missing_profile": doc([sk("q", [line(0, 0, 0, 30)], plane="XZ"), {"id": "w", "type": "sweep", "profile": "p", "path": "q", "operation": "new"}]),
    "sweep_open_profile": doc([sk("p", [line(0, 0, 3, 3)]), sk("q", [line(0, 0, 0, 30)], plane="XZ"),
                               {"id": "w", "type": "sweep", "profile": "p", "path": "q", "operation": "new"}]),
    "sweep_no_path_curve": doc([sk("p", [circle(2)]), sk("q", [circle(9)], plane="XZ"),
                                {"id": "w", "type": "sweep", "profile": "p", "path": "q", "operation": "new"}]),
    # the loop
    "active_off": doc([box("a", 10, 10, 10, activeWhen="flag"), box("b", 2, 2, 2, activeWhen=-2.5)], {"flag": 0}),
    "active_dependent": doc([sk("s", [rect(5, 5)], activeWhen="flag"), ext("e", "s", 5)], {"flag": 0}),
    "active_unresolved": doc([box("a", 10, 10, 10, activeWhen="missing")]),
    "active_shifted_body": doc([box("a", 10, 10, 10, activeWhen="flag"), box("b", 5, 5, 5),
                                {"id": "m", "type": "move", "dx": 3, "bodies": ["body2"]},
                                {"id": "r", "type": "removeBody", "bodies": ["body2"]}], {"flag": 0}),
    "unknown_type": doc([box("a", 1, 1, 1), {"id": "t", "type": "texture", "body": "body1"}]),
    "missing_type": doc([{"id": "x", "name": "Mystery"}]),
    "body_ids_recorded": doc([box("a", 1, 1, 1), box("b", 2, 2, 2)], bodyIds={"b:0": "body7", "a:0": "body3"}),
    "body_ids_join_inherit": doc([box("a", 10, 10, 10), box("b", 4, 4, 20, operation="join")], bodyIds={"a:0": "body4"}),
    "hidden_body_skipped": doc([box("a", 10, 10, 10), box("b", 4, 4, 20, operation="join")], bodyVisibility={"body1": False}),
    "nothing_built": doc([box("a", 0, 1, 1)]),
    "only_sketch": doc([sk("s", [rect(5, 5)])]),
    "owners_follow_a_move": doc([box("a", 10, 10, 10), sk("s", [circle(2)]), ext("e", "s", 20, "cut", symmetric=True),
                                 {"id": "m", "type": "move", "dx": 4, "rz": 30}, box("b", 3, 3, 30, operation="join")]),
}


def face_at(x, y, z, **extra):
    s = {"kind": "face", "by": "nearest", "point": [x, y, z]}
    s.update(extra)
    return s


def face_normal(x, y, z):
    return {"kind": "face", "by": "normal", "dir": [x, y, z]}


BLOCK = [sk("s", [rect(20, 20)]), ext("e", "s", 20)]
TUBE = [{"id": "c", "type": "cylinder", "radius": 10, "height": 20}]
BORED = [box("b", 30, 30, 10), {"id": "d", "type": "cylinder", "radius": 4, "height": 30, "operation": "cut"}]

SOLID_OPS_CASES = {
    # shell
    "shell_open_top": doc(BLOCK + [{"id": "sh", "type": "shell", "thickness": 2, "faces": face_normal(0, 0, 1)}]),
    "shell_closed": doc([box("b", 40, 40, 20), {"id": "sh", "type": "shell", "thickness": 2.5}]),
    "shell_negative_open": doc(BLOCK + [{"id": "sh", "type": "shell", "thickness": -3, "faces": [face_normal(0, 0, 1), face_normal(0, 0, -1)]}]),
    "shell_zero": doc(BLOCK + [{"id": "sh", "type": "shell", "thickness": 0}]),
    "shell_too_thick": doc([box("b", 10, 10, 10), {"id": "sh", "type": "shell", "thickness": 6}]),
    "shell_too_thick_open": doc(BLOCK + [{"id": "sh", "type": "shell", "thickness": 15, "faces": face_normal(0, 0, 1)}]),
    "shell_second_body": doc([box("a", 10, 10, 10), box("b", 10, 10, 10), {"id": "m", "type": "move", "dx": 30, "bodies": ["body2"]},
                              {"id": "sh", "type": "shell", "thickness": 1, "faces": face_at(30, 0, 5, body="body2")}]),
    "shell_stale_body": doc(BLOCK + [{"id": "sh", "type": "shell", "thickness": 1, "faces": face_at(0, 0, 20, body="body9")}]),
    "shell_cylinder_open": doc(TUBE + [{"id": "sh", "type": "shell", "thickness": 1.5, "faces": face_at(0, 0, 10)}]),
    # thicken
    "thicken_top_new": doc(BLOCK + [{"id": "t", "type": "thicken", "faces": face_normal(0, 0, 1), "thickness": 3}]),
    "thicken_top_join": doc(BLOCK + [{"id": "t", "type": "thicken", "faces": face_normal(0, 0, 1), "thickness": 3, "operation": "join"}]),
    "thicken_symmetric": doc(BLOCK + [{"id": "t", "type": "thicken", "faces": face_normal(1, 0, 0), "thickness": 2, "symmetric": True}]),
    "thicken_cylinder_side": doc(TUBE + [{"id": "t", "type": "thicken", "faces": face_at(10, 0, 0), "thickness": 2}]),
    "thicken_whole_body": doc([box("b", 10, 10, 10), {"id": "t", "type": "thicken", "thickness": 1}]),
    "thicken_zero": doc(BLOCK + [{"id": "t", "type": "thicken", "faces": face_normal(0, 0, 1), "thickness": 0}]),
    "thicken_missing_body": doc(BLOCK + [{"id": "t", "type": "thicken", "faces": face_normal(0, 0, 1), "thickness": 1, "body": "body5"}]),
    # draft
    "draft_sides": doc(BLOCK + [{"id": "dr", "type": "draft", "angle": 5,
                                 "faces": [face_normal(1, 0, 0), face_normal(-1, 0, 0), face_normal(0, 1, 0), face_normal(0, -1, 0)]}]),
    "draft_axis_x": doc([box("b", 20, 10, 10), {"id": "dr", "type": "draft", "angle": -8, "axis": "X", "faces": face_normal(0, 0, 1)}]),
    "draft_vertical": doc(BLOCK + [{"id": "dr", "type": "draft", "angle": 90, "faces": face_normal(1, 0, 0)}]),
    "draft_refused": doc(BLOCK + [{"id": "dr", "type": "draft", "angle": 10, "faces": face_normal(0, 0, 1)}]),
    "draft_two_bodies": doc([box("a", 10, 10, 10), box("b", 10, 10, 10), {"id": "m", "type": "move", "dx": 30, "bodies": ["body2"]},
                             {"id": "dr", "type": "draft", "angle": 3, "faces": [face_at(5, 0, 0, body="body1"), face_at(35, 0, 0, body="body2")]}]),
    # press/pull
    "pp_top_out": doc(BLOCK + [{"id": "p", "type": "press-pull", "face": face_at(0, 0, 20), "distance": 5}]),
    "pp_top_in": doc(BLOCK + [{"id": "p", "type": "press-pull", "face": face_at(0, 0, 20), "distance": -8}]),
    "pp_top_through": doc(BLOCK + [{"id": "p", "type": "press-pull", "face": face_at(0, 0, 20), "distance": -25}]),
    "pp_taper": doc(BLOCK + [{"id": "p", "type": "press-pull", "face": face_at(0, 0, 20), "distance": 5, "taper": 10}]),
    "pp_taper_bad": doc(BLOCK + [{"id": "p", "type": "press-pull", "face": face_at(0, 0, 20), "distance": 5, "taper": 89}]),
    "pp_two_faces": doc(BLOCK + [{"id": "p", "type": "press-pull", "face": [face_at(0, 0, 20), face_at(10, 0, 10)], "distance": 3}]),
    "pp_cylinder_out": doc(TUBE + [{"id": "p", "type": "press-pull", "face": face_at(10, 0, 0), "distance": 2}]),
    "pp_cylinder_in": doc(TUBE + [{"id": "p", "type": "press-pull", "face": face_at(10, 0, 0), "distance": -3}]),
    "pp_bore": doc(BORED + [{"id": "p", "type": "press-pull", "face": face_at(4, 0, 0), "distance": 1}]),
    "pp_sphere": doc([{"id": "s", "type": "sphere", "radius": 10},
                      {"id": "p", "type": "press-pull", "face": face_at(10, 0, 0), "distance": 2}]),
    "pp_up_to": doc([box("a", 10, 10, 10), box("b", 10, 10, 10), {"id": "m", "type": "move", "dz": 25, "bodies": ["body2"]},
                     {"id": "p", "type": "press-pull", "body": "body1", "face": face_at(0, 0, 5), "distance": 1,
                      "upTo": face_at(0, 0, 20)}]),
    "pp_up_to_parallel": doc([box("a", 10, 10, 10), {"id": "p", "type": "press-pull", "face": face_at(5, 0, 0), "distance": 1,
                                                     "upTo": face_at(0, 0, 5)}]),
    "pp_mode_new": doc(BLOCK + [{"id": "p", "type": "press-pull", "face": face_at(0, 0, 20), "distance": 5, "mode": "new"}]),
    "pp_mode_cut_other": doc([box("a", 10, 10, 10), box("b", 30, 30, 4), {"id": "m", "type": "move", "dz": 8, "bodies": ["body2"]},
                              {"id": "p", "type": "press-pull", "body": "body1", "face": face_at(0, 0, 5), "distance": 6, "mode": "cut"}]),
    "pp_mode_cylinder_join": doc(TUBE + [{"id": "p", "type": "press-pull", "face": face_at(10, 0, 0), "distance": 2, "mode": "join"}]),
    "pp_no_face": doc(BLOCK + [{"id": "p", "type": "press-pull", "face": face_normal(1, 1, 1), "distance": 5}]),
    "pp_missing_body": doc(BLOCK + [{"id": "p", "type": "press-pull", "body": "body4", "face": face_at(0, 0, 20), "distance": 5}]),
    "pp_loft_side": doc([sk("a", [rect(20, 20)]), sk("b", [circle(6, 3)], plane={"origin": [0, 0, 25], "normal": [0, 0, 1], "xdir": [1, 0, 0]}),
                         {"id": "l", "type": "loft", "sketches": ["a", "b"], "operation": "new"},
                         {"id": "p", "type": "press-pull", "face": face_at(9.27, 3.65, 12.5), "distance": 1}]),
    # offset face
    "off_top": doc(BLOCK + [{"id": "o", "type": "offsetFace", "faces": face_at(0, 0, 20), "distance": 3}]),
    "off_top_clamped": doc(BLOCK + [{"id": "o", "type": "offsetFace", "faces": face_at(0, 0, 20), "distance": -30}]),
    "off_cylinder_in": doc(TUBE + [{"id": "o", "type": "offsetFace", "faces": face_at(10, 0, 0), "distance": -2}]),
    "off_bore": doc(BORED + [{"id": "o", "type": "offsetFace", "faces": face_at(4, 0, 0), "distance": 1}]),
    "off_two_faces": doc(BLOCK + [{"id": "o", "type": "offsetFace", "faces": [face_at(0, 0, 20), face_at(10, 0, 10)], "distance": 2}]),
    "off_chamfered_rim": doc([sk("s", [line(0, 0, 29.7, 0), line(29.7, 0, 30, 0.3), line(30, 0.3, 30, 5), line(30, 5, 0, 5), line(0, 5, 0, 0)], plane="XZ"),
                              {"id": "r", "type": "revolve", "sketch": "s", "axis": "Z", "angle": 360},
                              {"id": "o", "type": "offsetFace", "faces": face_at(29.85, 0, 0.15), "distance": 1}]),
    "off_zero": doc(BLOCK + [{"id": "o", "type": "offsetFace", "faces": face_at(0, 0, 20), "distance": 0}]),
    "off_freeform": doc([sk("a", [rect(20, 20)]), sk("b", [circle(6, 3)], plane={"origin": [0, 0, 25], "normal": [0, 0, 1], "xdir": [1, 0, 0]}),
                         {"id": "l", "type": "loft", "sketches": ["a", "b"], "operation": "new"},
                         {"id": "o", "type": "offsetFace", "faces": face_at(9.27, 3.65, 12.5), "distance": 1}]),
    "off_missing_body": doc(BLOCK + [{"id": "o", "type": "offsetFace", "body": "body3", "faces": face_at(0, 0, 20), "distance": 1}]),
}
CASES.update(SOLID_OPS_CASES)


def volume(shape):
    p = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape.wrapped, p)
    return p.Mass()


def bbox(shape):
    b = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape.wrapped, b, True, False)
    if b.IsVoid():
        return None
    x0, y0, z0, x1, y1, z1 = b.Get()
    return [x0, y0, z0, x1, y1, z1]


def err_wire(e):
    w = {"message": e["message"], "feature_id": e.get("feature_id")}
    if e.get("code"):
        w["code"] = e["code"]
    return w


def run(document):
    diag, datums, ids = [], {}, {}
    _part, errors, bodies = builder.rebuild(
        json.loads(json.dumps(document)), diagnostics=diag, datums_out=datums, body_ids_out=ids)
    out_bodies = []
    for b in bodies:
        if b["shape"] is None:
            continue
        out_bodies.append({"id": b["id"], "name": b["name"], "volume": volume(b["shape"]),
                           "bbox": bbox(b["shape"]), "faces": len(b["shape"].faces()),
                           "solids": len(b["shape"].solids()),
                           "faceOwners": [(b.get("owners") or {}).get(_face_fp(fc)) for fc in b["shape"].faces()]})
    result = {
        "bodies": out_bodies,
        "errors": [err_wire(e) for e in errors],
        "diagnostics": [{"feature_id": d.get("feature_id"), "kind": d.get("kind"), "reason": d.get("reason")} for d in diag],
        "datumPlanes": datums,
    }
    if ids != document.get("bodyIds"):
        result["bodyIds"] = ids
    return result


def clean(v):
    if isinstance(v, float) and not math.isfinite(v):
        return None
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    if isinstance(v, list):
        return [clean(x) for x in v]
    return v


def main():
    out = {}
    for name, document in CASES.items():
        out[name] = {"doc": document, "expect": clean(run(document))}
        print(name, len(out[name]["expect"]["bodies"]), [e["message"] for e in out[name]["expect"]["errors"]])
    with open(os.path.join(HERE, "fixtures.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write("\n")


if __name__ == "__main__":
    main()
