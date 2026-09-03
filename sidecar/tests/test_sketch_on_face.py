"""A sketch made on a body face follows that face.

The bug this closes, measured before the fix. A 40x40 box 10 tall, a circle
sketched on its top face, cut 5mm down: an open pocket, 14994.7 mm3, one shell.
Raise the box to 20 and the sketch stays at z=10, so the cut happens INSIDE the
solid: 30994.7 mm3 in TWO shells, a sealed cavity nobody can see, print or
select, and the build stays green. Lower the box to 5 and the sketch floats
above it, which at least raises.

So a sketch picked on a face stores that face as the by:"nearest" selector every
other face tool already authors, and the plane is re-derived each rebuild. The
frozen `plane` stays as a cache and is what the resolution falls back to.

WHAT IS EASY TO GET WRONG, and is what most of this file tests. Plain nearest
binds the SIDE WALL after exactly the edit this exists to survive: the anchored
top face has moved away while the wall still sits right beside the stored point.
So candidates are filtered to faces parallel to the cached normal first, and
ranked by IN-PLANE distance, because the point stays over its face however far
that face slides along the normal. Each of the three survivors of that filter —
the face itself, its coplanar halves, a parallel sibling — has its own way of
being the silent wrong answer, and each gets a test here.

It NEVER raises. A sketch is a root: a raise means it never registers, every
extrude downstream quietly becomes a no-op, and one drifted reference takes the
whole document with it. Doubt falls back to the cache and reports why.

Run: uv run python tests/test_sketch_on_face.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import math
import sys
import traceback

from build123d import Box, Cylinder, Pos

import builder
import geom_select
from builder import rebuild

PASS = "  ok"

# The pick: the box's top face when it was 10 tall, touched off to one side so
# nothing here passes by accident on a centred point.
PICK = [3.0, 2.0, 10.0]
CACHED = {"origin": [0, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]}
R = 8.0
POCKET = math.pi * R * R * 5


def _doc(height, *, anchored=True, cut=True):
    """A box `height` tall with a circle sketched on the top face it had at 10,
    cut 5mm into it."""
    s2 = {"id": "s2", "type": "sketch", "plane": dict(CACHED),
          "entities": [{"type": "circle", "id": "c0", "x": 0, "y": 0, "radius": R}]}
    if anchored:
        s2["face"] = {"kind": "face", "by": "nearest", "point": list(PICK)}
        s2["at"] = list(PICK)
    feats = [
        {"id": "s1", "type": "sketch", "plane": "XY",
         "entities": [{"type": "rectangle", "id": "r0", "width": 40, "height": 40,
                       "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": height,
         "operation": "new", "regions": [[0, 0, 0]]},
        s2,
    ]
    if cut:
        feats.append({"id": "e2", "type": "extrude", "sketch": "s2", "distance": -5,
                      "operation": "cut", "regions": [[0, 0, 0]]})
    return {"parameters": {}, "paramDefs": {}, "version": 9, "features": feats}


def _build(doc):
    diag, planes = [], {}
    part, errs, bodies = rebuild(doc, diagnostics=diag, sketch_planes_out=planes)
    return {"errs": errs, "diag": diag, "planes": planes,
            "shape": bodies[-1]["shape"] if bodies else None}


def test_the_sealed_cavity_is_gone():
    for h in (10, 20, 5, 40):
        got = _build(_doc(h))
        shape = got["shape"]
        want = 40 * 40 * h - POCKET
        assert got["errs"] == [], (h, got["errs"])
        assert abs(shape.volume - want) < 1e-3, (h, shape.volume, want)
        # ONE shell. Two means the cut closed a cavity inside the solid, which
        # is the whole defect and which no error reports.
        assert len(shape.shells()) == 1, (h, len(shape.shells()))
        assert abs(got["planes"]["s2"]["origin"][2] - h) < 1e-6, (h, got["planes"])
    print(PASS, "the sketch follows its face and the cavity is gone")


def test_the_control_that_must_fail():
    # The same document with no face stored: every existing document takes this
    # path, and it must still behave exactly as it did. If this ever passes the
    # assertions above, the test above is proving nothing.
    got = _build(_doc(20, anchored=False))
    assert got["errs"] == [], got["errs"]
    assert len(got["shape"].shells()) == 2, len(got["shape"].shells())
    assert got["planes"] == {}, got["planes"]
    print(PASS, "a sketch with no face stored is untouched, cavity and all")


def test_a_sketch_that_never_moved_reports_the_same_plane_twice():
    # Float noise here would move every coordinate in every sketch on the face,
    # on every rebuild, so equality is exact on purpose.
    a = _build(_doc(20))["planes"]["s2"]
    b = _build(_doc(20))["planes"]["s2"]
    assert a == b, (a, b)
    print(PASS, "an unchanged document reports an identical plane")


def test_the_x_axis_the_sketch_was_drawn_in_is_kept():
    # Entities are stored as (u, v) in the plane's basis, so a re-derived x axis
    # turns every line in the sketch about the normal.
    doc = _doc(20)
    doc["features"][2]["plane"] = {"origin": [0, 0, 10], "normal": [0, 0, 1],
                                   "xdir": [0, 1, 0]}
    p = _build(doc)["planes"]["s2"]
    assert abs(p["xdir"][1] - 1) < 1e-9 and abs(p["xdir"][0]) < 1e-9, p["xdir"]
    print(PASS, "the x axis the sketch was drawn in is kept")


def test_a_reference_that_resolves_to_nothing_keeps_the_cache_and_says_so():
    doc = _doc(20)
    doc["features"][2]["face"] = {"kind": "face", "by": "nearest",
                                  "point": ["not", "a", "point"]}
    got = _build(doc)
    assert got["errs"] == [], got["errs"]          # a root never raises
    assert got["planes"] == {}, got["planes"]      # it stayed on the cache
    assert len(got["diag"]) == 1, got["diag"]
    d = got["diag"][0]
    assert d["code"] == geom_select.CODE_REFERENCE_NOT_FOUND, d
    assert d["lossy"] is False, d  # no best-effort match was taken; none was taken at all
    assert "Sketch:" in d["reason"] and "Re-pick" in d["reason"], d["reason"]
    print(PASS, "a dead reference keeps the cache and says why")


def test_an_incremental_rebuild_agrees_with_a_full_one():
    # The disk-resume path REPLAYS the prefix's sketches with no bodies in hand,
    # so a face-anchored sketch has nothing to resolve against there. The plane
    # it resolved to rides in the snapshot for exactly that reason; without it a
    # warm edit would rebuild the sketch on its stale cache and hand back a
    # different solid from the same document.
    from builder import rebuild_cached

    rebuild_cached(_doc(10))          # warms the cache at one height...
    planes = {}
    _part, errs, bodies = rebuild_cached(_doc(20), sketch_planes_out=planes)
    warm = bodies[-1]["shape"]
    cold = _build(_doc(20))["shape"]
    assert errs == [], errs
    assert abs(warm.volume - cold.volume) < 1e-6, (warm.volume, cold.volume)
    assert len(warm.shells()) == len(cold.shells()) == 1, (
        len(warm.shells()), len(cold.shells()))
    assert abs(planes["s2"]["origin"][2] - 20) < 1e-6, planes
    print(PASS, "an incremental rebuild agrees with a full one")


# --- the resolver's own rules ------------------------------------------------
#
# Driven directly, because each needs a shape a document cannot conveniently
# build, and because what is under test is which FACE comes back, not what the
# sketch then does with it.

def _resolve(shape, point, normal=(0, 0, 1), diag=None):
    sel = {"kind": "face", "by": "nearest", "point": list(point)}
    return geom_select.resolve_face_on_plane(shape, sel, normal, "Sketch", diag, "s2")


def test_the_side_wall_never_takes_the_anchor():
    # THE ORIGINAL BUG. The box grew from 10 to 20, so the anchored top face is
    # 10mm from the stored point while the side wall is 17mm from it in 3-D and
    # right beside it in every other sense. Plain nearest binds the wall over
    # most of the face's area; the co-normal filter removes it outright.
    box = Pos(0, 0, 10) * Box(40, 40, 20)  # z 0..20
    face = _resolve(box, [19.0, 2.0, 10.0])  # a point that WAS on the top, near an edge
    assert face is not None
    assert abs(face.center().Z - 20) < 1e-6, face.center()
    print(PASS, "the side wall never takes the anchor")


def test_a_parallel_sibling_does_not_steal_it():
    # A boss on a plate: two faces facing the same way at different heights. The
    # boss top is the anchored one and has been raised, so in 3-D the plate top
    # is now nearer the stored point. The IN-PLANE metric is what keeps the boss.
    part = Pos(0, 0, 5) * Box(60, 60, 10)                 # plate top at z 10
    part = part + (Pos(0, 0, 25) * Box(20, 20, 30))       # boss top at z 40
    face = _resolve(part, [2.0, 1.0, 15.0])               # picked when the boss was 15
    assert face is not None
    assert abs(face.center().Z - 40) < 1e-6, face.center()
    # ...and the control: a point OUTSIDE the boss belongs to the plate.
    other = _resolve(part, [25.0, 25.0, 10.0])
    assert other is not None and abs(other.center().Z - 10) < 1e-6, other.center()
    print(PASS, "a parallel sibling does not steal the anchor")


def test_the_floor_of_a_cut_does_not_steal_it():
    # THE UNMOVED-FACE OVERRIDE. A slot cut through the anchored face: the two
    # halves stay exactly where they were, and the slot floor sits below and
    # directly under the stored point, so the floor "contains" the point and the
    # halves do not. The face that did not move is the better explanation.
    part = Box(60, 60, 20)                                # top at z 10
    part = part - (Pos(0, 0, 6) * Box(14, 80, 8))         # a slot, floor at z 2
    face = _resolve(part, [0.0, 0.0, 10.0], diag=None)
    assert face is not None
    assert abs(face.center().Z - 10) < 1e-6, face.center()
    print(PASS, "the floor of a cut under the point does not steal the anchor")


def test_a_face_split_in_two_is_not_an_ambiguity():
    # A slot cut all the way THROUGH the anchored face, with the point over the
    # removed material: the two halves are EXACTLY equidistant, which the plain
    # tie rule refuses. They are the same plane and give the same answer, so the
    # tie is accepted rather than turning an edit that did nothing to the sketch
    # amber. Through, not blind, so nothing but the two halves is in the running.
    part = Box(60, 60, 20) - Box(14, 80, 40)
    diag = []
    face = _resolve(part, [0.0, 0.0, 10.0], diag=diag)
    assert face is not None, diag
    assert abs(face.center().Z - 10) < 1e-6, face.center()
    assert diag == [], diag
    print(PASS, "a face split in two is not an ambiguity")


def test_a_tie_across_two_real_planes_is_refused():
    # A thin plate whose top and bottom both face the same way is impossible on
    # one solid, so the honest ambiguity is two SEPARATE bodies at equal offsets
    # either side of the stored point. Neither is the anchored face; refusing is
    # the right answer and it has to say so.
    part = (Pos(0, 0, 6) * Box(40, 40, 2)) + (Pos(0, 0, -6) * Box(40, 40, 2))
    diag = []
    face = _resolve(part, [0.0, 0.0, 0.0], diag=diag)
    assert face is None
    assert len(diag) == 1 and diag[0]["code"] == geom_select.CODE_AMBIGUOUS_REFERENCE, diag
    assert diag[0]["at"] == [0.0, 0.0, 0.0], diag[0]
    print(PASS, "a tie across two real planes is refused, with a reason")


def test_a_tilted_face_keeps_the_cache_rather_than_following():
    # Nothing is parallel to the cached normal any more. Following the tilt would
    # re-frame the sketch's 2D entities into a rotated basis and move everything
    # downstream, so the plane stays and the reason says the repair is to put the
    # sketch on the face again rather than to re-pick the reference.
    from build123d import Rot
    part = Rot(0, 30, 0) * Box(40, 40, 20)
    diag = []
    face = _resolve(part, [0.0, 0.0, 10.0], diag=diag)
    assert face is None
    assert len(diag) == 1 and diag[0]["code"] == geom_select.CODE_PLANE_TILTED, diag
    assert "Re-pick" not in diag[0]["reason"], diag[0]["reason"]
    print(PASS, "a tilted face keeps the cache and asks for a different repair")


def test_a_body_with_no_flat_face_left_reports_the_face_is_gone():
    diag = []
    face = _resolve(builder._wrap_topods(__import__("build123d").Sphere(20).wrapped),
                    [0.0, 0.0, 20.0], diag=diag)
    assert face is None
    assert len(diag) == 1 and diag[0]["code"] == geom_select.CODE_REFERENCE_NOT_FOUND, diag
    print(PASS, "a body with no flat face left reports the face is gone")


def test_a_face_whose_orientation_flipped_is_still_found():
    # The reachable version of "the face's normal disagrees with the cache": a
    # boolean re-manufactures faces, and the surface a cut leaves behind is
    # oriented opposite the one it cut into. When NOTHING faces the cached way
    # the filter falls back to |dot| and binds the flipped face rather than
    # reporting a tilt.
    #
    # Isolated down to ONE reversed face on purpose. Reversing a whole solid
    # flips both its ends, so the far end starts facing the cached way and the
    # same-sign pass takes it — correctly, and without ever reaching the
    # fallback this test is about.
    top = [f for f in Cylinder(20, 10).faces()
           if abs(f.center().Z - 5) < 1e-9][0]
    flipped = builder._wrap_topods(top.wrapped.Reversed())
    diag = []
    face = geom_select.resolve_face_on_plane(
        flipped, {"kind": "face", "by": "nearest", "point": [0.0, 0.0, 5.0]},
        (0, 0, 1), "Sketch", diag, "s2")
    assert face is not None, diag
    assert abs(face.center().Z - 5) < 1e-6, face.center()
    assert diag == [], diag
    print(PASS, "a face whose orientation flipped is still found")


def main():
    failed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
        except Exception:
            traceback.print_exc()
            print(f"FAIL {name}")
            failed += 1
    print("sketch on face:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
