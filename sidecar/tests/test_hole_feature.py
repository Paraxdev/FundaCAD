"""The Hole feature: removed volume against the analytic value for every hole
type, blind against through all, several positions in one feature, a side face,
positions from a sketch, and refusals that name the problem.

Run: uv run python tests/test_hole_feature.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import math
import sys
import traceback

from build123d import Vector

import hole_feature
from builder import rebuild

PASS = "  ok"
TOL = 1e-3

BLOCK = 40 * 40 * 20
BASE = [
    {"id": "s1", "type": "sketch", "plane": "XY",
     "entities": [{"type": "rectangle", "width": 40, "height": 40, "x": 0, "y": 0}]},
    {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 20, "operation": "new"},
]
TOP = {"kind": "face", "by": "nearest", "point": [0, 0, 20]}


def build(*features, params=None):
    _p, errors, bodies = rebuild({"parameters": params or {}, "features": BASE + list(features)})
    return errors, bodies


def removed(hole, params=None):
    errors, bodies = build(hole, params=params)
    assert not errors, errors
    assert len(bodies) == 1, len(bodies)
    return BLOCK - bodies[0]["shape"].volume


def hole(**kw):
    f = {"id": "h", "type": "hole", "face": TOP, "points": [[0, 0, 20]]}
    f.update(kw)
    return f


def cyl(r, h):
    return math.pi * r * r * h


def frustum(R, r, h):
    return math.pi * h / 3 * (R * R + R * r + r * r)


def close(a, b):
    assert abs(a - b) < TOL * max(1.0, abs(b)), (a, b)


def test_simple_blind_and_through():
    close(removed(hole(diameter=4, depth=8)), cyl(2, 8))
    close(removed(hole(diameter=4, depth=8, extent="through")), cyl(2, 20))
    print(PASS, "a simple hole removes its cylinder, blind to depth or through the block")


def test_drill_point():
    tip = 2 / math.tan(math.radians(59))
    close(removed(hole(diameter=4, depth=8, drillPoint=True)), cyl(2, 8) + math.pi * 4 * tip / 3)
    # through all has no bottom to put a point on
    close(removed(hole(diameter=4, extent="through", drillPoint=True)), cyl(2, 20))
    print(PASS, "the 118 degree drill point adds its cone to a blind hole only")


def test_counterbore():
    got = removed(hole(holeType="counterbore", diameter=3.4, extent="through",
                       cbDiameter=6.5, cbDepth=3.4))
    close(got, cyl(1.7, 20) + cyl(3.25, 3.4) - cyl(1.7, 3.4))
    print(PASS, "a counterbore removes the bore plus its step")


def test_countersink():
    sink = (6.9 - 3.4) / 2  # 90 degrees
    got = removed(hole(holeType="countersink", diameter=3.4, extent="through",
                       csDiameter=6.9, csAngle=90))
    close(got, cyl(1.7, 20) + frustum(3.45, 1.7, sink) - cyl(1.7, sink))
    print(PASS, "a countersink removes the bore plus its cone")


def test_standard_sizes_fill_in_dimensions():
    close(removed(hole(size="M3", fit="normal", extent="through")), cyl(1.7, 20))
    close(removed(hole(size="M3", fit="close", extent="through")), cyl(1.6, 20))
    close(removed(hole(size="M4", standard="tap", depth=10)), cyl(3.3 / 2, 10))
    got = removed(hole(holeType="counterbore", size="M3", extent="through"))
    close(got, cyl(1.7, 20) + cyl(3.25, 3.4) - cyl(1.7, 3.4))
    # the heat-set insert preset: 4.0 bore, 6 deep, 0.5 lead-in chamfer
    got = removed(hole(holeType="insert", size="M3"))
    close(got, cyl(2, 6) + frustum(2.5, 2, 0.5) - cyl(2, 0.5))
    close(removed(hole(holeType="insert", size="M3", leadIn=0)), cyl(2, 6))
    print(PASS, "a size and fit, a tap drill, a socket head and an insert give their dimensions")


def test_parameter_driven_diameter():
    close(removed(hole(diameter="hd", depth=5), params={"hd": 6}), cyl(3, 5))
    print(PASS, "a parameter drives the diameter")


def test_several_positions():
    pts = [[-10, -10, 20], [10, -10, 20], [0, 10, 20]]
    close(removed(hole(diameter=4, depth=8, points=pts)), 3 * cyl(2, 8))
    print(PASS, "three positions in one feature cut three holes")


def test_side_face():
    side = {"kind": "face", "by": "nearest", "point": [20, 0, 10]}
    errors, bodies = build(hole(face=side, points=[[20, 5, 10]], diameter=4, depth=10))
    assert not errors, errors
    shape = bodies[0]["shape"]
    close(BLOCK - shape.volume, cyl(2, 10))
    assert not shape.is_inside(Vector(15, 5, 10)), "the hole runs in along -X"
    assert shape.is_inside(Vector(15, -5, 10))
    assert shape.is_inside(Vector(5, 5, 10)), "stops at its depth"
    print(PASS, "a hole on the +X side face drills along -X")


def test_positions_from_a_sketch():
    sk = {"id": "s2", "type": "sketch",
          "plane": {"origin": [0, 0, 20], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
          "entities": [{"type": "point", "x": -8, "y": 0}, {"type": "point", "x": 8, "y": 0}]}
    h = {"id": "h", "type": "hole", "sketch": "s2", "diameter": 3, "depth": 4}
    errors, bodies = build(sk, h)
    assert not errors, errors
    close(BLOCK - bodies[0]["shape"].volume, 2 * cyl(1.5, 4))
    circles = dict(sk, entities=[{"type": "circle", "radius": 1, "x": 0, "y": 12}])
    errors, bodies = build(circles, h)
    assert not errors, errors
    close(BLOCK - bodies[0]["shape"].volume, cyl(1.5, 4))
    print(PASS, "a sketch's points, or its circles' centres, place the holes")


def expect_error(feature, needle):
    errors, bodies = build(feature)
    assert len(errors) == 1, errors
    assert errors[0]["feature_id"] == "h", errors
    assert needle in errors[0]["message"], errors[0]["message"]
    assert "failed (" not in errors[0]["message"], errors[0]["message"]
    close(bodies[0]["shape"].volume, BLOCK)
    return errors[0]


def test_bad_inputs_are_named():
    expect_error(hole(face={"kind": "face", "by": "sideways"}, diameter=4), "selector")
    expect_error(hole(face={"kind": "face", "by": "nearest"}, diameter=4), "malformed")
    err = expect_error(hole(face=dict(TOP, body="body9"), diameter=4), "no longer exists")
    assert err.get("code") == "referenceNotFound", err
    expect_error(hole(points=[], diameter=4), "no positions")
    expect_error(hole(), "diameter")
    expect_error(hole(diameter=4, size="M7"), "unknown size")
    expect_error(hole(holeType="counterbore", diameter=4, cbDiameter=3, cbDepth=2), "larger")
    expect_error(hole(holeType="insert", size="M8"), "insert")
    # a round face cannot be drilled along a normal
    boss = [{"id": "c", "type": "cylinder", "radius": 5, "height": 10, "operation": "new"}]
    _p, errors, _b = rebuild({"parameters": {}, "features": boss + [
        {"id": "h", "type": "hole", "face": {"kind": "face", "by": "nearest", "point": [5, 0, 0]},
         "points": [[5, 0, 0]], "diameter": 2, "depth": 2}]})
    assert len(errors) == 1 and "flat" in errors[0]["message"], errors
    print(PASS, "a bad selector, a missing body, no positions and bad sizes are named errors")


def test_tables_match_the_app():
    # tests/features/holeStandards.test.ts pins the same numbers on the app side
    assert hole_feature.CLEARANCE["M3"] == (3.2, 3.4, 3.6)
    assert hole_feature.TAP_DRILL["M5"] == 4.2
    assert hole_feature.COUNTERBORE["M4"] == (8.0, 4.4)
    assert hole_feature.COUNTERSINK["M6"] == 13.7
    assert hole_feature.INSERT["M3"] == (4.0, 6.0)
    assert hole_feature.standard_dims("counterbore", "clearance", "M5", "loose") == {
        "diameter": 5.8, "cbDiameter": 10.0, "cbDepth": 5.4}
    print(PASS, "the standard tables hold their pinned values")


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
        except Exception:
            failed += 1
            print("  FAIL", t.__name__)
            traceback.print_exc()
    print(f"{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
