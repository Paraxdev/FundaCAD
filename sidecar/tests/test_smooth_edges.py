"""Blending an edge that is already smooth.

The report: a block with rounded corners, one top edge picked, a 1.768mm
chamfer refused with OCCT's "Failed creating a chamfer, try a smaller length
value(s)". Smaller values were tried. They fail too, measured, the operation
fails identically at 5mm and at 0.05mm.

The cause is not size. A fillet or a chamfer cuts across the corner between two
faces, and the picked edge was the boundary of a round, where the two faces
meet TANGENTIALLY. Measured dihedral: 90 degrees on a plain box edge, 0.00 on
that one. There is no corner there, so there is nothing to cut at any size.

That makes OCCT's message not merely unhelpful but wrong: it describes a size
problem, so it sends the user into a retry loop that cannot terminate. These
tests hold the honest refusal, and, just as important, hold that ordinary
corners are still allowed, because a guard like this fails silently by refusing
everything.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from build123d import Solid

from builder import SMOOTH_EDGE_DEG, _edge_dihedral_deg, _refuse_smooth_edges


def _rounded_block():
    """A block with rounded verticals, then a rounded top perimeter, so the
    only edges left on the top plane are the boundaries of a round."""
    b = Solid.make_box(30, 20, 24)
    vert = [e for e in b.edges() if abs(e.tangent_at(0.5).Z) > 0.9]
    plain = b.fillet(4.0, vert)
    zmax = plain.bounding_box().max.Z
    tops = [e for e in plain.edges()
            if abs(e.position_at(0).Z - zmax) < 1e-6 and abs(e.position_at(1).Z - zmax) < 1e-6]
    return plain, tops, plain.fillet(1.5, tops)


def _top_edges(shape):
    z = shape.bounding_box().max.Z
    return [e for e in shape.edges()
            if abs(e.position_at(0).Z - z) < 1e-6 and abs(e.position_at(1).Z - z) < 1e-6]


def test_the_dihedral_tells_the_two_apart():
    """The measurement the guard rests on. If this stops separating a corner
    from a tangency, the guard either refuses everything or nothing."""
    plain, tops, rounded = _rounded_block()
    corner = _edge_dihedral_deg(plain, tops[0])
    smooth = _edge_dihedral_deg(rounded, _top_edges(rounded)[0])
    assert corner is not None and corner > 45, f"box edge read as {corner}"
    assert smooth is not None and smooth < SMOOTH_EDGE_DEG, f"round boundary read as {smooth}"
    print(f"dihedral OK: box corner {corner:.2f}deg, round boundary {smooth:.2f}deg")


def test_an_ordinary_corner_is_still_allowed():
    """The failure mode of a guard like this is refusing real work, and it would
    be invisible, every blend would just start reporting the new message."""
    plain, tops, _ = _rounded_block()
    _refuse_smooth_edges(plain, tops, "Chamfer")  # must not raise
    box = Solid.make_box(10, 10, 10)
    _refuse_smooth_edges(box, list(box.edges()), "Fillet")  # must not raise
    print("ordinary corners still allowed OK (box + rounded-corner block)")


def test_the_reported_case_is_refused_with_the_reason():
    _plain, _tops, rounded = _rounded_block()
    try:
        _refuse_smooth_edges(rounded, _top_edges(rounded), "Chamfer")
    except ValueError as ex:
        msg = str(ex)
        assert "smooth" in msg, msg
        # The whole point is that it must NOT repeat OCCT's size advice.
        assert "smaller" in msg and "no smaller value will help" in msg, (
            f"the message must contradict the size advice, not echo it: {msg}")
        print(f"refused OK: {msg[:96]}...")
        return
    raise AssertionError("a tangent edge was accepted for chamfering")


def test_an_unknown_edge_is_not_assumed_smooth():
    """None from the dihedral means 'could not tell', a seam, a free edge, a
    degenerate normal. Reading that as smooth would refuse blends on perfectly
    good geometry, so the guard has to let unknowns through."""
    cyl = Solid.make_cylinder(6, 20)
    # a cylinder's seam has the same face on both sides; whatever the measure
    # returns for it, nothing here may be refused on that basis alone
    _refuse_smooth_edges(cyl, list(cyl.edges()), "Fillet")
    print("unknown/seam edges are not treated as smooth OK")


if __name__ == "__main__":
    try:
        test_the_dihedral_tells_the_two_apart()
        test_an_ordinary_corner_is_still_allowed()
        test_the_reported_case_is_refused_with_the_reason()
        test_an_unknown_edge_is_not_assumed_smooth()
        print("\nall smooth-edge tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
