"""Thread-forming ribs. Run from sidecar/: uv run python ../plugins/FundaCAD.PrintToolbox/geometry/tests/test_ribs.py"""

import _bootstrap  # noqa: F401
from _docs import assert_one_valid_solid, block, build, error_for, face_at, inside, only_body, vol, y_hole

PASS = "  ok"
R = 3.0
Z = 10.0
L = 20.0


def _base():
    return block(30, L, 20) + y_hole(R, Z)


def test_default_ribs_add_the_analytic_volume():
    before_errors, before_bodies = build(_base())
    assert not before_errors, before_errors
    before = vol(only_body(before_bodies))

    feats = _base() + [{"id": "tr", "type": "threadRibs", "faces": face_at((0, 0, Z + R))}]
    errors, bodies = build(feats)
    assert not errors, errors
    shape = only_body(bodies)
    assert_one_valid_solid(shape)

    core_r = 0.8 * R
    protrusion = R - core_r
    ribbed = L - 2 * 0.5  # both ends open, default 0.5 mm lead-in each side
    want = 3 * 0.6 * protrusion * ribbed
    added = vol(shape) - before
    assert abs(added - want) < 5e-2 * want, (added, want)
    for y in (-8, 0, 8):
        assert not inside(shape, (0, y, Z)), "the axis of the hole must stay clear for the screw"
    print(PASS, "3 default ribs add 3 x width x protrusion x ribbed length of material")


def test_explicit_core_diameter_and_count():
    before_errors, before_bodies = build(_base())
    before = vol(only_body(before_bodies))
    feats = _base() + [{"id": "tr", "type": "threadRibs", "faces": face_at((0, 0, Z + R)),
                        "ribCount": 5, "ribWidth": 0.4, "coreDiameter": 4.0, "startDepth": 1.0}]
    errors, bodies = build(feats)
    assert not errors, errors
    shape = only_body(bodies)
    assert_one_valid_solid(shape)
    protrusion = R - 2.0
    ribbed = L - 2 * 1.0
    want = 5 * 0.4 * protrusion * ribbed
    added = vol(shape) - before
    assert abs(added - want) < 5e-2 * want, (added, want)
    assert not inside(shape, (0, 0, Z)), "the 4 mm core stays open"
    print(PASS, "an explicit core diameter, count, width and start depth all take effect")


def test_blind_hole_ribs_only_the_open_end():
    # The sketch plane sits at y=0, the middle of the 20 mm deep block: cutting
    # far past the +Y face (distance -100) opens that end cleanly while y=0
    # stays a genuine floor, giving one blind end and one open end.
    feats = block(30, 20, 20) + [
        {"id": "sh", "type": "sketch", "plane": "XZ",
         "entities": [{"type": "circle", "radius": R, "x": 0, "y": Z}]},
        {"id": "eh", "type": "extrude", "sketch": "sh", "distance": -100, "operation": "cut"},
    ]
    errors, bodies = build(feats)
    assert not errors, errors
    before = vol(only_body(bodies))
    errors, bodies = build(feats + [{"id": "tr", "type": "threadRibs", "faces": face_at((0, 5, Z + R))}])
    assert not errors, errors
    after = only_body(bodies)
    assert_one_valid_solid(after)
    core_r = 0.8 * R
    protrusion = R - core_r
    ribbed = 10.0 - 0.5  # only the open end (at y=10) gets a lead-in, the y=0 floor does not
    want = 3 * 0.6 * protrusion * ribbed
    added = vol(after) - before
    assert abs(added - want) < 5e-2 * want, (added, want)
    print(PASS, "a blind hole's lead-in only trims the open end")


def test_overlapping_ribs_are_refused():
    feats = _base() + [{"id": "tr", "type": "threadRibs", "faces": face_at((0, 0, Z + R)),
                        "ribCount": 8, "ribWidth": 3.0}]
    errors, _ = build(feats)
    msg = error_for(errors, "tr")
    assert msg and "overlap" in msg, errors
    print(PASS, "ribs wide enough to overlap around the hole are refused")


def test_non_cylinder_is_refused():
    errors, _ = build(_base() + [{"id": "tr", "type": "threadRibs", "faces": face_at((0, 0, 20))}])
    msg = error_for(errors, "tr")
    assert msg and "not cylindrical" in msg, errors
    print(PASS, "a flat face is refused by name")


def main():
    print("Print toolbox: thread-forming ribs")
    test_default_ribs_add_the_analytic_volume()
    test_explicit_core_diameter_and_count()
    test_blind_hole_ribs_only_the_open_end()
    test_overlapping_ribs_are_refused()
    test_non_cylinder_is_refused()
    print("ALL PASS")


if __name__ == "__main__":
    main()
