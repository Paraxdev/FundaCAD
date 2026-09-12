"""Divide a face by imprinting a sketch's curves onto it.

Run:  python test_imprint.py

Draw a sketch on a solid face and the curves that reach across it split that
face into separate, independently selectable faces, with no material added or
removed. A "+" drawn across a box top makes four top faces where there was one;
a single line makes two; a circle imprints a disk. The body stays one watertight
solid throughout (the split only adds face boundaries), so the volume is exactly
what it was.

Curves that DON'T reach the boundary form no closed sub-region, so they divide
nothing, that is an advisory (the sketch is a legitimate imprint that simply
hasn't cut anything yet), never a build error.

The whole point of the feature is those separate faces, so every test counts
faces, and every test checks the volume did not budge.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from builder import rebuild
from shape_util import _as_compound

from OCP.BRepCheck import BRepCheck_Analyzer

PASS = "  ok"

# The box's top face, touched off-centre so nothing passes on a lucky centred point.
TOP_PICK = [3.0, 2.0, 20.0]
TOP_PLANE = {"origin": [0, 0, 20], "normal": [0, 0, 1], "xdir": [1, 0, 0]}


def _doc(entities, *, imprint=True):
    """A 40x40x20 box with `entities` sketched on its top face, optionally divided."""
    feats = [
        {"id": "s1", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "id": "r0", "width": 40, "height": 40,
                       "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 20,
         "operation": "new", "regions": [[0, 0, 0]]},
        {"id": "s2", "type": "sketch", "plane": dict(TOP_PLANE),
         "face": {"kind": "face", "by": "nearest", "point": list(TOP_PICK)},
         "at": list(TOP_PICK), "entities": entities},
    ]
    if imprint:
        feats.append({"id": "im1", "type": "imprint", "sketch": "s2"})
    return {"parameters": {}, "paramDefs": {}, "version": 9, "features": feats}


def _plus(half):
    return [
        {"type": "line", "id": "lx", "x1": -half, "y1": 0, "x2": half, "y2": 0},
        {"type": "line", "id": "ly", "x1": 0, "y1": -half, "x2": 0, "y2": half},
    ]


def _build(doc):
    diag = []
    _part, errs, bodies = rebuild(doc, diagnostics=diag)
    shape = _as_compound(bodies[0]["shape"]) if bodies else None
    return {"errs": errs, "diag": diag, "shape": shape,
            "faces": len(shape.faces()) if shape else 0,
            "solids": len(shape.solids()) if shape else 0,
            "vol": shape.volume if shape else 0.0}


def test_a_plus_splits_the_top_into_four():
    got = _build(_doc(_plus(20)))
    assert got["errs"] == [], got["errs"]
    # 6 box faces, top (1) becomes 4 quadrants -> 9.
    assert got["faces"] == 9, got["faces"]
    assert got["solids"] == 1, got["solids"]
    assert abs(got["vol"] - 40 * 40 * 20) < 1e-3, got["vol"]
    assert BRepCheck_Analyzer(got["shape"].wrapped).IsValid(), "split solid is invalid"
    print(PASS, "a '+' across the top makes four top faces, one watertight solid")


def test_one_line_splits_the_top_in_two():
    got = _build(_doc([{"type": "line", "id": "lx", "x1": -20, "y1": 0,
                        "x2": 20, "y2": 0}]))
    assert got["errs"] == [], got["errs"]
    assert got["faces"] == 7, got["faces"]
    assert abs(got["vol"] - 40 * 40 * 20) < 1e-3, got["vol"]
    print(PASS, "one line across the top makes two top faces")


def test_a_circle_imprints_a_disc():
    got = _build(_doc([{"type": "circle", "id": "c0", "x": 0, "y": 0, "radius": 10}]))
    assert got["errs"] == [], got["errs"]
    # top becomes a ring + a disc -> one extra face.
    assert got["faces"] == 7, got["faces"]
    assert abs(got["vol"] - 40 * 40 * 20) < 1e-3, got["vol"]
    print(PASS, "a circle on the top imprints a disc face")


def test_curves_that_miss_the_boundary_divide_nothing_and_say_so():
    got = _build(_doc(_plus(8)))  # a small floating cross, well inside the edges
    assert got["errs"] == [], got["errs"]          # never a build error
    assert got["faces"] == 6, got["faces"]         # the face stayed whole
    assert abs(got["vol"] - 40 * 40 * 20) < 1e-3, got["vol"]
    advisory = [d for d in got["diag"] if d.get("feature_id") == "im1"]
    assert len(advisory) == 1 and advisory[0].get("lossy") is True, got["diag"]
    assert "don't divide" in advisory[0]["reason"], advisory[0]["reason"]
    print(PASS, "a floating cross divides nothing and flags an advisory, not an error")


def test_the_control_without_the_divide_is_a_plain_box():
    # The same sketch, no imprint feature: the box is untouched. If this ever
    # shows extra faces, the tests above are proving nothing.
    got = _build(_doc(_plus(20), imprint=False))
    assert got["errs"] == [], got["errs"]
    assert got["faces"] == 6, got["faces"]
    print(PASS, "with no Divide feature the box keeps its six faces")


if __name__ == "__main__":
    try:
        test_a_plus_splits_the_top_into_four()
        test_one_line_splits_the_top_in_two()
        test_a_circle_imprints_a_disc()
        test_curves_that_miss_the_boundary_divide_nothing_and_say_so()
        test_the_control_without_the_divide_is_a_plain_box()
        print("\nall imprint tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
