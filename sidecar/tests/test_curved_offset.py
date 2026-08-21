"""Resizing a hole must not depend on the rest of the body.

Press/Pull and Offset Face send a curved face to _offset_faces, which is OCCT's
BRepOffset over the WHOLE solid. When that will not run it refuses every face at
once, including ones that move perfectly well on their own — measured on the
reported document, where two bores in a body carrying six blend surfaces could
not be resized by any amount in either direction. The fallback then made it
worse: a linear sweep has no direction to travel along on a face that closes on
itself, so a hole landed on "its surface is freeform and wraps around", which is
not true of a cylinder and not a size the user could fix.

_thicken_press_pull asks the smaller question — thicken THIS face, boolean the
slab in — and it is the one a hole can answer.

Run: uv run python tests/test_curved_offset.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

from build123d import Box, Cylinder, Pos

import builder
from builder import _press_pull, _sweep_press_pull, _thicken_press_pull
from geom_select import resolve_faces

PASS = "  ok"

R = 3.0
DEPTH = 12.0
BLOCK = Box(40, 40, 20)
BORE = Pos(8, 8, 10 - DEPTH / 2) * Cylinder(R, DEPTH)
PART = BLOCK - BORE
BORE_WALL = [8.0 + R, 8.0, 10 - DEPTH / 2]  # a point on the bore's surface


def bore():
    return resolve_faces(PART, {"kind": "face", "by": "nearest", "point": BORE_WALL})[0]


def bore_radius_of(shape):
    return float(
        resolve_faces(shape, {"kind": "face", "by": "nearest", "point": BORE_WALL})[0].radius
    )


def test_the_bore_is_the_face_we_think_it_is():
    f = bore()
    assert abs(f.radius - R) < 1e-9, f.radius
    assert abs(f.area - 2 * 3.141592653589793 * R * DEPTH) < 1e-6, f.area
    print(PASS, f"the pick lands on the bore wall (r={f.radius:g}, closed cylinder)")


def test_thickening_moves_the_wall_by_exactly_the_distance():
    # +d grows the body, so on a hole it grows INWARD and the bore gets tighter,
    # which is the operation the report is about. -d is the control: the same
    # call the other way must open it by the same amount, not do nothing.
    tighter = _thicken_press_pull(PART, bore(), 1.25)
    wider = _thicken_press_pull(PART, bore(), -1.25)
    assert abs(bore_radius_of(tighter) - (R - 1.25)) < 1e-9, bore_radius_of(tighter)
    assert abs(bore_radius_of(wider) - (R + 1.25)) < 1e-9, bore_radius_of(wider)
    assert builder._solid_volume(tighter) > builder._solid_volume(PART)
    assert builder._solid_volume(wider) < builder._solid_volume(PART)
    print(PASS, f"r {R:g} -> {bore_radius_of(tighter):g} tighter, {bore_radius_of(wider):g} wider")


def test_the_sweep_cannot_do_this_at_all():
    """The control that must fail. If the sweep could take a closed cylinder,
    the fallback added above would be dead code and the bug would have been
    somewhere else."""
    try:
        _sweep_press_pull(PART, bore(), 1.25)
    except ValueError as ex:
        assert "wraps around" in str(ex), str(ex)
        print(PASS, "the linear sweep still refuses a face that wraps (control)")
        return
    raise AssertionError("the sweep moved a closed cylinder; the fallback proves nothing")


def test_press_pull_reaches_the_fallback_when_the_body_offset_will_not_run():
    """The wiring. _offset_faces failing is a property of the WHOLE body, which
    takes an exotic solid to provoke honestly, so it is failed on purpose here —
    what is under test is that press/pull then lands on the thickened result
    rather than on the sweep's refusal."""
    real = builder._offset_face
    builder._offset_face = lambda *a, **k: (_ for _ in ()).throw(
        ValueError("can't offset this face by that amount")
    )
    try:
        out = _press_pull(PART, bore(), 1.25)
    finally:
        builder._offset_face = real
    assert abs(bore_radius_of(out) - (R - 1.25)) < 1e-9, bore_radius_of(out)
    print(PASS, "press/pull resizes the bore even with the body offset refusing")


if __name__ == "__main__":
    test_the_bore_is_the_face_we_think_it_is()
    test_thickening_moves_the_wall_by_exactly_the_distance()
    test_the_sweep_cannot_do_this_at_all()
    test_press_pull_reaches_the_fallback_when_the_body_offset_will_not_run()
    print("ALL PASS")
