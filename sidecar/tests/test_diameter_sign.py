"""The sign a cylindrical Press/Pull needs, pinned on the kernel side.

Dragging a round face now resizes it instead of translating it, and the drag
handle points AWAY FROM THE AXIS on a shaft and on a hole alike, pulling
outward means "bigger" either way, because that is the only reading a user does
not have to think about.

The kernel does not work in those terms. A press/pull distance moves a face
along its own outward normal, and that normal points away from the axis on a
shaft but AT the axis on a bore. So the frontend converts:

    distance = +delta on a boss,  -delta on a bore     (features/radialDrag.ts)

That conversion is a sign, and a sign that is wrong does not raise anything: the
hole you dragged open closes instead. These tests are the other half of the
seam, they assert what the kernel actually does with each sign, so the two
halves cannot drift apart silently.

Run:  python test_diameter_sign.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from build123d import GeomType, Location, Solid

from builder import _clamp_cylinder, _press_pull
from test_conic_blend import mesh_volume


def _bore(outer=20, hole=5, h=10):
    """A block with a hole through it: the bore wall is the CYLINDER face."""
    block = Solid.make_box(outer, outer, h).move(Location((-outer / 2, -outer / 2, 0)))
    return block - Solid.make_cylinder(hole, h)


def _cyl_face(shape, radius):
    for f in shape.faces():
        if f.geom_type == GeomType.CYLINDER and abs(float(f.radius) - radius) < 1e-6:
            return f
    raise AssertionError(f"no cylindrical face of radius {radius}")


def test_a_positive_distance_grows_a_shaft():
    """solidInside=True sends +delta. A 10mm shaft pulled 1mm outward is 12
    across, and the extra material is a ring, not a longer shaft."""
    s = Solid.make_cylinder(5, 10)
    v0 = mesh_volume(s.wrapped)
    out = _press_pull(s, _cyl_face(s, 5), 1.0)
    v1 = mesh_volume(out.wrapped)
    assert v1 > v0, f"+1 on a shaft removed material ({v0:.1f} -> {v1:.1f})"
    assert abs(float(_cyl_face(out, 6).radius) - 6) < 1e-6, "radius did not reach 6"
    print(f"shaft +1 -> r6 OK ({v0:.1f} -> {v1:.1f})")


def test_a_negative_distance_grows_a_bore():
    """solidInside=False sends -delta, and this is the assertion that catches the
    inversion: the user dragged the hole OPEN, so material must go away."""
    s = _bore(hole=5)
    v0 = mesh_volume(s.wrapped)
    out = _press_pull(s, _cyl_face(s, 5), -1.0)
    v1 = mesh_volume(out.wrapped)
    assert v1 < v0, f"opening a hole added material ({v0:.1f} -> {v1:.1f})"
    assert abs(float(_cyl_face(out, 6).radius) - 6) < 1e-6, "hole did not reach r6"
    print(f"bore -1 -> r6 OK ({v0:.1f} -> {v1:.1f})")


def test_the_two_signs_really_are_opposites():
    """Symmetry check. If the kernel treated a bore like a shaft, both of the
    tests above could still pass on a lucky volume comparison; this one cannot."""
    s = _bore(hole=5)
    tighter = _press_pull(s, _cyl_face(s, 5), 1.0)
    assert abs(float(_cyl_face(tighter, 4).radius) - 4) < 1e-6, (
        "+1 on a bore should SHRINK it to r4, if this fails the frontend's sign "
        "flip is unnecessary and radialDrag.ts is wrong"
    )
    print("bore +1 -> r4 OK (the flip is required)")


def test_the_collapse_floor_matches_the_frontends():
    """radialDrag.COLLAPSE_FRACTION is 0.1 because _clamp_cylinder caps an inward
    offset at 90% of the radius. If this cap ever moves, the frontend promises a
    diameter the kernel then silently clamps to a different one."""
    f = _cyl_face(Solid.make_cylinder(5, 10), 5)
    assert abs(_clamp_cylinder(f, -100) - -4.5) < 1e-9, "the 90% cap moved"
    assert abs(_clamp_cylinder(f, 100) - 4.5) < 1e-9
    assert _clamp_cylinder(f, -1.0) == -1.0, "the cap must not touch an ordinary drag"
    print("clamp still 90% of the radius OK")


if __name__ == "__main__":
    try:
        test_a_positive_distance_grows_a_shaft()
        test_a_negative_distance_grows_a_bore()
        test_the_two_signs_really_are_opposites()
        test_the_collapse_floor_matches_the_frontends()
        print("\nall diameter-sign tests passed")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
