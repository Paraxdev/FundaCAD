"""Parity fixtures for fundacad-geom's selector resolution, measured on sidecar/geom_select.py.

Every part is a build123d shape written as text BREP and read back, and the
Python resolver runs against the read-back shape, so the Rust test resolves on
the very same B-rep. Per case the fixture keeps what the resolver returned (a
summary of each entity, in order), or the error it raised, plus every
diagnostic it pushed.

Run from anywhere with the sidecar's interpreter:
    sidecar/.venv/Scripts/python.exe crates/fundacad-geom/tests/select/gen.py
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SIDECAR = os.path.normpath(os.path.join(HERE, "..", "..", "..", "..", "sidecar"))
sys.path.insert(0, SIDECAR)
os.chdir(SIDECAR)

from build123d import Axis, Box, Compound, Cylinder, Pos, Sphere, fillet  # noqa: E402
from OCP.BRep import BRep_Builder  # noqa: E402
from OCP.BRepTools import BRepTools  # noqa: E402
from OCP.TopoDS import TopoDS_Shape  # noqa: E402
from OCP.TopTools import TopTools_FormatVersion  # noqa: E402

import geom_select as gs  # noqa: E402
from builder import _as_compound, _serial_bool  # noqa: E402
from errors import GeomError  # noqa: E402
from shape_util import _wrap_topods  # noqa: E402


def parts():
    b = Box(20, 20, 10)
    yield "box", b
    yield "pipe", Cylinder(10, 10) - Cylinder(5, 10)
    yield "holed", Box(40, 40, 10) - Cylinder(5, 30)
    yield "twin_holes", Box(60, 30, 10) - Pos(15, 0, 0) * Cylinder(4, 30) - Pos(-15, 0, 0) * Cylinder(4, 30)
    yield "round_corners", fillet(b.edges().filter_by(Axis.Z), 3)
    plate = Pos(0, 0, -2.5) * Box(60, 60, 5)
    prisms = Compound([Pos(-5, 5, 4.5) * Box(10, 10, 9), Pos(5, -5, 4.5) * Box(10, 10, 9)])
    yield "touching_prisms", _serial_bool(_as_compound(plate), _as_compound(prisms), "fuse")
    yield "slotted", Box(40, 20, 5) - Box(6, 30, 10)
    yield "step", Box(20, 20, 10) + Pos(20, 0, 2.5) * Box(20, 20, 15)
    yield "ball", Sphere(6)


def edge_ent(e):
    """What the Rust test compares an entity by, raw numbers, no rounding."""
    m = gs._edge_mid(e)
    return {"type": gs._edge_curve(e), "at": [m.X, m.Y, m.Z], "size": e.length}


def face_ent(f):
    c = gs._face_centroid(f)
    return {"type": gs._face_surface(f), "at": [c.X, c.Y, c.Z], "size": f.area}


def run(part, fn, sel, extra):
    diag = []
    out = {"diag": diag}
    try:
        if fn == "edges":
            out["result"] = [edge_ent(e) for e in gs.resolve_edges(part, sel, diag, "f1")]
        elif fn == "faces":
            out["result"] = [face_ent(f) for f in gs.resolve_faces(part, sel, diag, "f1")]
        elif fn == "plane":
            f = gs.resolve_face_on_plane(part, sel, extra["normal"], extra["label"], diag, "f1")
            out["result"] = [] if f is None else [face_ent(f)]
        elif fn == "edge_fp":
            e = [x for x in part.edges()][extra["index"]]
            out["fp"] = gs.edge_fingerprint(e, part)
        elif fn == "face_fp":
            f = [x for x in part.faces()][extra["index"]]
            out["fp"] = gs.face_fingerprint(f, part)
    except GeomError as ex:
        out["error"] = {"type": "value", "message": str(ex), "code": ex.code}
    except ValueError as ex:
        out["error"] = {"type": "value", "message": str(ex), "code": None}
    except KeyError as ex:
        out["error"] = {"type": "missing", "message": str(ex.args[0]), "code": None}
    return out


def fp_edge(part, pick):
    return gs.edge_fingerprint(pick(part), part)


def fp_face(part, pick):
    return gs.face_fingerprint(pick(part), part)


def top_face(p):
    return max(p.faces(), key=lambda f: gs._face_centroid(f).Z)


def edge_where(p, pred):
    return next(e for e in p.edges() if pred(e))


def cases(shapes):
    box, pipe, holed = shapes["box"], shapes["pipe"], shapes["holed"]
    rc, twin = shapes["round_corners"], shapes["twin_holes"]
    E = lambda **kw: {"kind": "edge", **kw}  # noqa: E731
    F = lambda **kw: {"kind": "face", **kw}  # noqa: E731
    top_front = edge_where(box, lambda e: gs._edge_curve(e) == "line" and abs(gs._edge_dir(e).X) > 0.99
                           and abs(gs._edge_mid(e).Y - 10) < 1e-6 and abs(gs._edge_mid(e).Z - 5) < 1e-6)
    rims = sorted((e for e in pipe.edges() if gs._edge_curve(e) == "circle" and gs._edge_mid(e).Z > 4),
                  key=gs._edge_radius)
    twin_rim = max((e for e in twin.edges() if gs._edge_curve(e) == "circle" and gs._edge_center(e).X > 0),
                   key=lambda e: gs._edge_mid(e).Z)
    arc = edge_where(rc, lambda e: gs._edge_curve(e) == "circle" and gs._edge_mid(e).Z > 4)

    # axis
    for a in ("X", "Y", "Z"):
        yield f"axis_{a}_box", "box", "edges", E(by="axis", axis=a), {}
    yield "axis_Z_round_corners", "round_corners", "edges", E(by="axis", axis="Z"), {}
    yield "axis_unknown", "box", "edges", E(by="axis", axis="W"), {}
    yield "axis_missing", "box", "edges", E(by="axis"), {}
    # all
    yield "all_edges_pipe", "pipe", "edges", E(by="all"), {}
    yield "all_faces_holed", "holed", "faces", F(by="all"), {}
    # nearest edges
    yield "nearest_edge_clear", "box", "edges", E(by="nearest", point=[9, 9.5, 5.2]), {}
    yield "nearest_edge_tie_refuses", "touching_prisms", "edges", E(by="nearest", point=[-5.0, 5.0, 4.5]), {}
    yield "nearest_edge_tie_nth", "touching_prisms", "edges", E(by="nearest", point=[-5.0, 5.0, 4.5], nth=2), {}
    yield "nearest_edge_seam_dedup", "touching_prisms", "edges", E(by="nearest", point=[0.0, 0.0, 4.5]), {}
    yield "nearest_edge_no_point", "box", "edges", E(by="nearest"), {}
    # match edges
    yield "match_edge_box", "box", "edges", E(by="match", fp=gs.edge_fingerprint(top_front, box)), {}
    yield "match_edge_outer_rim", "pipe", "edges", E(by="match", fp=gs.edge_fingerprint(rims[1], pipe)), {}
    yield "match_edge_inner_rim", "pipe", "edges", E(by="match", fp=gs.edge_fingerprint(rims[0], pipe)), {}
    yield "match_edge_rims_list", "pipe", "edges", [E(by="match", fp=gs.edge_fingerprint(rims[1], pipe)),
                                                     E(by="match", fp=gs.edge_fingerprint(rims[0], pipe))], {}
    yield "match_edge_twin_rim", "twin_holes", "edges", E(by="match", fp=gs.edge_fingerprint(twin_rim, twin)), {}
    yield "match_edge_twin_rim_on_holed", "holed", "edges", E(by="match", fp=gs.edge_fingerprint(twin_rim, twin)), {}
    bad = {"mid": [100, 100, 100], "dir": [1, 0, 0], "length": 999, "curve": "line"}
    yield "match_edge_poor", "box", "edges", E(by="match", fp=bad), {}
    sym = {"mid": [0, 0, 0], "dir": [0, 0, 1], "length": 10, "curve": "line"}
    yield "match_edge_tie_canonical", "box", "edges", E(by="match", fp=sym), {}
    yield "match_edge_tie_nth", "box", "edges", E(by="match", fp=sym, nth=3), {}
    yield "match_edge_missing_mid", "box", "edges", E(by="match", fp={"dir": [1, 0, 0]}), {}
    # tangent chain
    yield "tangent_chain_round_corners", "round_corners", "edges", E(by="tangentChain", seed=gs.edge_fingerprint(arc, rc)), {}
    yield "tangent_chain_box", "box", "edges", E(by="tangentChain", seed=gs.edge_fingerprint(top_front, box)), {}
    # of face, and a face selector in an edge field
    yield "of_face_top", "box", "edges", E(by="ofFace", face=gs.face_fingerprint(top_face(box), box)), {}
    yield "of_face_pipe_top", "pipe", "edges", E(by="ofFace", face=gs.face_fingerprint(top_face(pipe), pipe)), {}
    yield "face_selector_in_edge_field", "box", "edges", F(by="nearest", point=[1, 2, 5.1]), {}
    yield "unknown_edge_selector", "box", "edges", E(by="spiral"), {}
    # faces
    yield "normal_up_pipe", "pipe", "faces", F(by="normal", dir=[0, 0, 2]), {}
    yield "normal_tilted_box", "box", "faces", F(by="normal", dir=[1, 0.1, 0]), {}
    yield "nearest_face_clear", "holed", "faces", F(by="nearest", point=[0, 5.5, 1]), {}
    yield "nearest_face_corner_refuses", "box", "faces", F(by="nearest", point=[10, 10, 5]), {}
    yield "nearest_face_corner_nth", "box", "faces", F(by="nearest", point=[10, 10, 5], nth=1), {}
    yield "nearest_face_slid_out", "box", "faces", F(by="nearest", point=[15, 0, 5]), {}
    yield "match_face_top", "box", "faces", F(by="match", fp=gs.face_fingerprint(top_face(box), box)), {}
    wall = next(f for f in holed.faces() if gs._face_surface(f) == "cylinder")
    yield "match_face_wall", "holed", "faces", F(by="match", fp=gs.face_fingerprint(wall, holed)), {}
    yield "match_face_poor", "box", "faces", F(by="match", fp={"centroid": [50, 0, 0], "normal": [0, 1, 0]}), {}
    yield "match_face_list", "box", "faces", [F(by="match", fp=gs.face_fingerprint(top_face(box), box)),
                                              F(by="normal", dir=[0, 0, 1])], {}
    yield "unknown_face_selector", "box", "faces", F(by="axis", axis="Z"), {}
    # face-anchored planes
    plane = lambda n, label="Sketch": {"normal": n, "label": label}  # noqa: E731
    yield "plane_follows_top", "step", "plane", {"point": [0, 0, 4]}, plane([0, 0, 1])
    yield "plane_coplanar_halves", "slotted", "plane", {"point": [0, 0, 2.5]}, plane([0, 0, 1])
    yield "plane_ambiguous_step", "step", "plane", {"point": [10, 0, 7.5]}, plane([0, 0, 1], "Plane")
    yield "plane_tilted", "box", "plane", {"point": [0, 0, 5]}, plane([1, 1, 0])
    yield "plane_far_side_by_abs", "ball", "plane", {"point": [0, 0, 6]}, plane([0, 0, 1])
    yield "plane_bad_point", "box", "plane", {"point": [0, "x", 5]}, plane([0, 0, 1])
    yield "plane_flat_face_down", "box", "plane", {"point": [3, 3, -5]}, plane([0, 0, -1])
    # authoring
    for i in range(len(pipe.edges())):
        yield f"edge_fp_pipe_{i}", "pipe", "edge_fp", None, {"index": i}
    for i in (0, 4):
        yield f"edge_fp_box_{i}", "box", "edge_fp", None, {"index": i}
    for i in range(len(holed.faces())):
        yield f"face_fp_holed_{i}", "holed", "face_fp", None, {"index": i}
    yield "face_fp_ball", "ball", "face_fp", None, {"index": 0}


def main():
    shapes = {}
    for name, part in parts():
        path = os.path.join(HERE, name + ".brep")
        BRepTools.Write_s(part.wrapped, path, False, False, TopTools_FormatVersion.TopTools_FormatVersion_VERSION_3)
        with open(path, "rb") as fh:
            text = fh.read().replace(b"\r\n", b"\n")
        with open(path, "wb") as fh:
            fh.write(text)
        topods = TopoDS_Shape()
        BRepTools.Read_s(topods, path, BRep_Builder())
        shapes[name] = _wrap_topods(topods)

    out = []
    for name, part, fn, sel, extra in cases(shapes):
        rec = {"name": name, "part": part, "fn": fn, "selector": sel, **extra}
        rec.update(run(shapes[part], fn, sel, extra))
        out.append(rec)
    with open(os.path.join(HERE, "fixtures.json"), "w", newline="\n") as fh:
        json.dump(out, fh, indent=1)
        fh.write("\n")
    print(f"wrote {len(out)} cases", file=sys.stderr)


if __name__ == "__main__":
    main()
