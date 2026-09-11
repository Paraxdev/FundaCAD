"""A sweep follows the WHOLE path, even when the path arrives in fragments.

A sweep path is combined from a sketch's free edges. When two edges that are
meant to be continuous are parted by a sub-micron gap (a projected or
round-tripped path, where the kernel that rebuilt it disagrees with the one that
authored it by a hair), Wire.combine at its 1e-9 mm default split them into
separate wires, and _path_wire then kept only the LONGEST and dropped the rest.
An L path swept as a straight stub of one leg, a valid solid, so nothing
downstream flagged the missing half.

_path_wire now stitches fragments within PATH_STITCH_TOL, so the whole path is
followed. It still falls back to the longest wire for GENUINELY separate paths
(millimetres apart), which must not be merged.

Run: uv run python tests/test_sweep_path.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import math

from build123d import Edge, Plane, Circle, sweep, Transition
from OCP.BRepCheck import BRepCheck_Analyzer

from sketch_build import _path_wire, PATH_STITCH_TOL

PASS = "  ok"


def test_a_path_parted_by_a_submicron_gap_is_followed_whole():
    """An L whose two 10mm legs meet across a 1e-4 mm gap. Both legs are the same
    length, so the old 'keep the longest' kept one 10mm leg and dropped the
    other; the whole path is 20mm."""
    legs = [Edge.make_line((0, 0, 0), (10, 0, 0)),
            Edge.make_line((10.0001, 0, 0), (10.0001, 10, 0))]  # 1e-4 mm gap at the corner
    w = _path_wire(legs, Plane.XY)
    assert w is not None, "the fragmented path produced no wire"
    assert abs(w.length - 20.0) < 1e-2, \
        f"expected the whole 20mm path, got {w.length:.4f}mm (a dropped fragment)"
    print(PASS, "a path parted by a sub-micron gap is stitched and followed whole")


def test_the_swept_solid_spans_the_whole_path():
    """Verify by the SOLID, not just the wire: a 1mm-radius tube along the
    stitched 20mm path has ~twice the volume of the truncated 10mm stub the old
    code would have swept."""
    legs = [Edge.make_line((0, 0, 0), (10, 0, 0)),
            Edge.make_line((10.0001, 0, 0), (10.0001, 10, 0))]
    path = _path_wire(legs, Plane.XY)
    # profile in the plane perpendicular to the path's start tangent (+X at origin)
    prof = Plane((0, 0, 0), x_dir=(0, 1, 0), z_dir=(1, 0, 0)) * Circle(1)
    s = sweep(sections=prof, path=path, transition=Transition.RIGHT)
    assert BRepCheck_Analyzer(s.wrapped).IsValid(), "the swept solid is not valid"
    full = math.pi * 1 * 1 * 20  # ~62.8; the 10mm stub would be ~31.4
    assert s.volume > 0.85 * full, \
        f"the sweep spanned only part of the path: vol {s.volume:.1f} vs whole ~{full:.1f}"
    print(PASS, "the swept solid spans the whole path, not one leg")


def test_genuinely_separate_paths_are_not_merged():
    """CONTROL: two 10mm edges 5mm apart are separate paths, not a stitch case.
    The stitch tolerance is a micron, so they stay separate and the fallback
    picks ONE (length 10), it must NOT report a merged 20mm wire."""
    far = [Edge.make_line((0, 0, 0), (10, 0, 0)),
           Edge.make_line((15, 0, 0), (25, 0, 0))]  # 5mm gap: a real discontinuity
    w = _path_wire(far, Plane.XY)
    assert w is not None
    assert abs(w.length - 10.0) < 1e-6, \
        f"separate paths were wrongly merged into {w.length:.4f}mm"
    print(PASS, "genuinely separate paths are not merged (fallback to the longest)")


def test_a_contiguous_path_is_unchanged():
    """CONTROL: an L whose legs share an EXACT endpoint already combined into one
    wire at any tolerance and must still measure the whole 20mm."""
    legs = [Edge.make_line((0, 0, 0), (10, 0, 0)),
            Edge.make_line((10, 0, 0), (10, 10, 0))]
    w = _path_wire(legs, Plane.XY)
    assert abs(w.length - 20.0) < 1e-9, f"a clean path changed length: {w.length}"
    print(PASS, "a contiguous path is unchanged")


def main():
    assert PATH_STITCH_TOL == 1e-3, PATH_STITCH_TOL
    test_a_path_parted_by_a_submicron_gap_is_followed_whole()
    test_the_swept_solid_spans_the_whole_path()
    test_genuinely_separate_paths_are_not_merged()
    test_a_contiguous_path_is_unchanged()
    print("ALL PASS")


if __name__ == "__main__":
    main()
