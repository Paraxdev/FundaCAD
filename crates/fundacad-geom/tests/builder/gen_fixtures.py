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
