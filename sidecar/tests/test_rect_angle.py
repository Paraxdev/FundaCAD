"""A rotated rectangle builds the shape the sketch drew.

`rectangle` gained an `angle` (degrees, about its own centre) so a rectangle
drawn from three points can be SAVED as a rectangle instead of decomposed into
four lines, which would cost it its W/H dimension, its "<rectId>~k" edge
addressing and its identity in the browser tree.

The risk is a split brain. The frontend draws, picks and snaps from
src/sketch/region.ts rectCorners; the solid is built from builder._rect_corners.
If those two ever disagree the sketch extrudes into a shape nobody drew, and it
looks like a rendering bug rather than a geometry one. So the corner values are
asserted here against the same numbers the TypeScript test asserts.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import math
import sys
import traceback

from builder import _rect_corners, rebuild
from test_conic_blend import mesh_volume


def _val(v):
    return float(v)


def _rect(**kw):
    e = {"type": "rectangle", "id": "r1", "width": 10, "height": 4, "x": 0, "y": 0}
    e.update(kw)
    return e


def test_no_angle_leaves_the_corners_untouched():
    """Every rectangle in every saved document takes this path. Routing them
    through a cos/sin would move them by float noise, a diff in every file
    anyone opens and re-saves, for no change in shape."""
    for e in (_rect(x=3, y=5), _rect(x=3, y=5, angle=0)):
        assert _rect_corners(e, _val) == [(-2, 3), (8, 3), (8, 7), (-2, 7)], e
    print("angle 0 corners are exact OK")


def test_the_angle_is_degrees_about_the_rectangles_own_centre():
    """Two things that are easy to get wrong and silent when wrong: radians for
    degrees (a 90 that barely moves), and rotating about the ORIGIN, which throws
    an off-centre rectangle across the sketch the moment it gains an angle."""
    c = _rect_corners(_rect(x=100, y=0, angle=90), _val)
    cx = sum(p[0] for p in c) / 4
    cy = sum(p[1] for p in c) / 4
    assert abs(cx - 100) < 1e-9 and abs(cy) < 1e-9, c
    w = max(p[0] for p in c) - min(p[0] for p in c)
    h = max(p[1] for p in c) - min(p[1] for p in c)
    assert abs(w - 4) < 1e-9 and abs(h - 10) < 1e-9, f"90 deg should swap the extents, got {w}x{h}"
    print("angle is degrees, about the centre OK")


def test_the_corners_match_the_frontends_to_the_last_digit():
    """The same numbers tests/sketch/region.test.ts asserts. This is the seam."""
    c = _rect_corners(_rect(x=-7, y=2, angle=37.5), _val)
    a = math.radians(37.5)
    co, si = math.cos(a), math.sin(a)
    want = [(-7 + lx * co - ly * si, 2 + lx * si + ly * co)
            for lx, ly in ((-5, -2), (5, -2), (5, 2), (-5, 2))]
    for got, exp in zip(c, want):
        assert abs(got[0] - exp[0]) < 1e-12 and abs(got[1] - exp[1]) < 1e-12, (got, exp)
    # still counter-clockwise, still 10 x 4, the edge addressing depends on both
    area = sum(c[i][0] * c[(i + 1) % 4][1] - c[(i + 1) % 4][0] * c[i][1] for i in range(4)) / 2
    assert area > 0, "corner order must stay CCW"
    assert abs(area - 40) < 1e-9, area
    print("corners agree with the frontend, CCW, 10x4 OK")


def test_a_rotated_rectangle_extrudes_to_the_same_volume():
    """Rotating a profile cannot change how much material it makes. A build that
    quietly ignored the angle would also pass that, so the BBOX is checked too:
    it is what actually tells a rotated extrusion from an axis-aligned one."""
    def doc(angle):
        return {
            "parameters": {},
            "features": [
                {"id": "s1", "type": "sketch", "plane": "XY",
                 "entities": [_rect(x=0, y=0, angle=angle)]},
                {"id": "f1", "type": "extrude", "sketch": "s1", "distance": 3,
                 "operation": "new"},
            ],
        }

    flat, err0, _ = rebuild(doc(0))
    turned, err1, _ = rebuild(doc(45))
    assert not err0 and not err1, (err0, err1)
    v0, v1 = mesh_volume(flat.wrapped), mesh_volume(turned.wrapped)
    assert abs(v1 - v0) < 1.0, f"rotation changed the volume: {v0:.2f} -> {v1:.2f}"
    assert abs(v0 - 10 * 4 * 3) < 1.0, f"expected 120mm3, got {v0:.2f}"

    b0, b1 = flat.bounding_box(), turned.bounding_box()
    assert abs(b0.size.X - 10) < 1e-6 and abs(b0.size.Y - 4) < 1e-6, b0.size
    # 10x4 turned 45 degrees spans (10+4)/sqrt(2) ~= 9.899 in both axes
    span = 14 / math.sqrt(2)
    assert abs(b1.size.X - span) < 1e-6 and abs(b1.size.Y - span) < 1e-6, (
        f"the angle was ignored: bbox is {b1.size}, expected {span:.3f} square")
    print(f"rotated extrusion OK: {v0:.1f}mm3, bbox {b0.size.X:.2f}x{b0.size.Y:.2f} "
          f"-> {b1.size.X:.2f}x{b1.size.Y:.2f}")


if __name__ == "__main__":
    try:
        test_no_angle_leaves_the_corners_untouched()
        test_the_angle_is_degrees_about_the_rectangles_own_centre()
        test_the_corners_match_the_frontends_to_the_last_digit()
        test_a_rotated_rectangle_extrudes_to_the_same_volume()
        print("\nall rectangle-angle tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
