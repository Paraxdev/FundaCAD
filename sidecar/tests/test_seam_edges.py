"""Blending a seam.

The report: a revolved part, a fillet, and "Fillet failed on Body1:
ChFi3d_Builder:only 2 faces". Nothing in that sentence names anything a person
can go and change.

What it means is that the picked edge is a SEAM. A face that wraps all the way
round — the side of a cylinder or a cone, a 360-degree revolve — closes on
itself, and the kernel records that closure as a topological edge. It is
bookkeeping, not geometry: there is no crease along it and both sides of it are
the SAME face. ChFi3d needs two different faces to blend between, so it refuses,
and it refuses the same way at every radius.

The guard is deliberately narrow, and the control below is the reason: a broad
selector routinely sweeps a seam up along with real edges — by:"axis" on a
cylinder picks the seam because the seam IS parallel to the axis — and OCCT
blends those groups perfectly well. Refusing them would break work that has
always worked. So the refusal fires only when there is nothing else in the
selection.

Run: uv run python tests/test_seam_edges.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from build123d import Axis, Plane, Polyline, Solid, make_face, revolve

from blends import _refuse_seam_edges
from topo_adj import FaceAdjacency


def _cone():
    """A revolved triangle: one conical face, one flat base. Two faces, and the
    exact shape the report was about — small enough that the whole side of it is
    a single face that wraps."""
    prof = Plane.XZ * Polyline((0, 0), (12, 0), (0, 18), (0, 0))
    return revolve(make_face(prof), Axis.Z, 360)


def _seams_of(shape):
    adj = FaceAdjacency(shape)
    out = []
    for e in shape.edges():
        f = adj.faces_of_edge(e)
        if len(f) == 2 and f[0] == f[1]:
            out.append(e)
    return out


def test_the_cone_has_exactly_one_seam():
    cone = _cone()
    assert len(list(cone.faces())) == 2, [f.geom_type for f in cone.faces()]
    seams = _seams_of(cone)
    assert len(seams) == 1, f"expected one seam, found {len(seams)}"


def test_a_seam_on_its_own_is_refused_with_the_reason():
    cone = _cone()
    seam = _seams_of(cone)[0]
    try:
        _refuse_seam_edges(cone, [seam], "Fillet")
    except ValueError as ex:
        msg = str(ex)
        assert "seam" in msg, msg
        assert "same face" in msg, msg
        print(f"seam refused OK: {msg}")
        return
    raise AssertionError("a lone seam edge was allowed through")


def test_an_ordinary_edge_is_still_allowed():
    """The control that keeps the guard from refusing everything."""
    box = Solid.make_box(20, 20, 10)
    _refuse_seam_edges(box, list(box.edges()), "Fillet")
    cone = _cone()
    rim = [e for e in cone.edges() if e not in _seams_of(cone)]
    assert rim, "the cone should have a rim as well as a seam"
    _refuse_seam_edges(cone, rim, "Fillet")
    print("ordinary edges still allowed OK")


def test_a_seam_MIXED_with_real_edges_is_allowed_through():
    """The narrowness of the guard, held as a property.

    by:"axis" on a cylinder returns the seam along with everything parallel to
    it, and by:"all" returns it too. Both of those blend today; refusing them
    would be a regression dressed as a fix."""
    cone = _cone()
    _refuse_seam_edges(cone, list(cone.edges()), "Fillet")
    print("a seam mixed with real edges is allowed OK")


def test_an_edge_from_another_shape_does_not_read_as_a_seam():
    """An edge the map has never heard of comes back with NO faces, not with the
    same face twice. Treating 'unknown' as 'seam' would refuse blends on
    perfectly good geometry the moment a caller passed a shape that had been
    rebuilt."""
    cone = _cone()
    other = Solid.make_box(5, 5, 5)
    _refuse_seam_edges(cone, list(other.edges()), "Fillet")
    print("edges from another shape are not seams OK")


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
    print("seam edges:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
