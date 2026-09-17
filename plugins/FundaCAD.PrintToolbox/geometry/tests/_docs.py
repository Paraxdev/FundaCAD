"""Test documents and measurements shared by this plugin's geometry tests."""

import _bootstrap  # noqa: F401

from OCP.BRepCheck import BRepCheck_Analyzer

import ptb_occ as g
from builder import rebuild


def block(w, d, h, sid="s1", eid="e1"):
    """A w x d x h block, centred on the origin in XY, from z=0 up."""
    return [
        {"id": sid, "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "width": w, "height": d, "x": 0, "y": 0}]},
        {"id": eid, "type": "extrude", "sketch": sid, "distance": h, "operation": "new"},
    ]


def y_hole(r, z, length=100, sid="sh", eid="eh"):
    """A through hole along Y at height z."""
    return [
        {"id": sid, "type": "sketch", "plane": "XZ",
         "entities": [{"type": "circle", "radius": r, "x": 0, "y": z}]},
        {"id": eid, "type": "extrude", "sketch": sid, "distance": length, "symmetric": True,
         "operation": "cut"},
    ]


def z_cut(r, depth, sid, eid):
    """A round pocket from z=0 upward."""
    return [
        {"id": sid, "type": "sketch", "plane": "XY",
         "entities": [{"type": "circle", "radius": r, "x": 0, "y": 0}]},
        {"id": eid, "type": "extrude", "sketch": sid, "distance": depth, "operation": "cut"},
    ]


def face_at(p):
    return {"kind": "face", "by": "nearest", "point": list(p)}


def build(features):
    part, errors, bodies = rebuild({"parameters": {}, "features": features})
    return errors, bodies


def only_body(bodies):
    assert len(bodies) == 1, f"expected one body, got {len(bodies)}"
    return bodies[0]["shape"]


def assert_one_valid_solid(shape):
    topo = shape.wrapped
    assert BRepCheck_Analyzer(topo).IsValid(), "the result is not a valid solid"
    assert len(g.solids(topo)) == 1, f"expected one solid, got {len(g.solids(topo))}"


def vol(shape):
    return g.volume(shape.wrapped)


def inside(shape, p):
    return g.inside(shape.wrapped, p)


def error_for(errors, fid):
    for e in errors:
        if e.get("feature_id") == fid:
            return e.get("message") or ""
    return None
