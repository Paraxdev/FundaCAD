"""Elephant-foot chamfer and vertical edge fillet.
Run from sidecar/: uv run python ../plugins/FundaCAD.PrintToolbox/geometry/tests/test_edges.py"""

import math

import _bootstrap  # noqa: F401
from _docs import assert_one_valid_solid, block, build, error_for, face_at, inside, only_body, vol

PASS = "  ok"


def test_elephant_foot_removes_the_analytic_volume():
    w, d, h, s = 20.0, 15.0, 10.0, 0.4
    errors, bodies = build(block(w, d, h))
    assert not errors, errors
    before = vol(only_body(bodies))
    feats = block(w, d, h) + [{"id": "ef", "type": "elephantFootChamfer", "size": s}]
    errors, bodies = build(feats)
    assert not errors, errors
    shape = only_body(bodies)
    assert_one_valid_solid(shape)
    want = (w + d) * s * s - (4.0 / 3.0) * s ** 3
    removed = before - vol(shape)
    assert abs(removed - want) < 1e-3 * want + 1e-9, (removed, want)

    assert not inside(shape, (w / 2 - 0.1, d / 2 - 0.1, 0.05)), "the bottom corner is chamfered away"
    assert inside(shape, (w / 2 - 0.1, d / 2 - 0.1, h - 0.05)), "the top corner stays sharp"
    print(PASS, "an elephant-foot chamfer removes (w+d)s^2 - 4/3 s^3 and leaves the top sharp")


def test_elephant_foot_ignores_bottom_holes():
    feats = block(20, 20, 10) + [
        {"id": "sh", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "radius": 2, "x": 0, "y": 0}]},
        {"id": "eh", "type": "extrude", "sketch": "sh", "distance": 10, "operation": "cut"},
        {"id": "ef", "type": "elephantFootChamfer", "size": 0.4},
    ]
    errors, bodies = build(feats)
    assert not errors, errors
    shape = only_body(bodies)
    assert_one_valid_solid(shape)
    assert not inside(shape, (0, 0, 5)), "the through hole stays open"
    assert not inside(shape, (9.9, 9.9, 0.05)), "the outer bottom corner is still chamfered"
    print(PASS, "a hole through the bottom face is left alone, only the outer perimeter is chamfered")


def test_elephant_foot_size_is_validated():
    errors, _ = build(block(20, 20, 10) + [{"id": "ef", "type": "elephantFootChamfer", "size": 0}])
    msg = error_for(errors, "ef")
    assert msg and "between 0.01 and 20" in msg, errors
    print(PASS, "an out-of-range size is refused by name")


def test_vertical_fillet_removes_the_analytic_volume():
    w, d, h, r = 20.0, 15.0, 10.0, 2.0
    errors, bodies = build(block(w, d, h))
    before = vol(only_body(bodies))
    feats = block(w, d, h) + [{"id": "vf", "type": "verticalFillet", "radius": r}]
    errors, bodies = build(feats)
    assert not errors, errors
    shape = only_body(bodies)
    assert_one_valid_solid(shape)
    want = r * r * (4 - math.pi) * h
    removed = before - vol(shape)
    assert abs(removed - want) < 1e-3 * want, (removed, want)
    assert not inside(shape, (w / 2, d / 2, h / 2)), "the corner is rounded away"
    assert inside(shape, (0, d / 2 - 0.01, h / 2)), "the flat wall away from a corner is untouched"
    assert not inside(shape, (0, d / 2 + 0.01, h / 2))
    print(PASS, "a vertical fillet rounds all 4 corners for r^2 (4 - pi) h and leaves the flat walls alone")


def _l_shape(w, h):
    return [
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": [{"type": "rectangle", "width": w, "height": w, "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": h, "operation": "new"},
        {"id": "s2", "type": "sketch", "plane": "XY", "entities": [{"type": "rectangle", "width": w / 2, "height": w / 2, "x": w / 4, "y": w / 4}]},
        {"id": "e2", "type": "extrude", "sketch": "s2", "distance": h, "operation": "cut"},
    ]


def test_vertical_fillet_only_convex_skips_the_reflex_edge():
    w, h, r = 20.0, 10.0, 1.0
    errors, bodies = build(_l_shape(w, h))
    assert not errors, errors
    before = vol(only_body(bodies))
    per_corner = r * r * (1 - math.pi / 4) * h

    both = _l_shape(w, h) + [{"id": "vf", "type": "verticalFillet", "radius": r}]
    errors, bodies = build(both)
    assert not errors, errors
    shape_both = only_body(bodies)
    assert_one_valid_solid(shape_both)
    # 5 convex corners lose material, the 1 reflex corner gains it back.
    assert abs((before - vol(shape_both)) - 4 * per_corner) < 1e-3 * per_corner, "5 convex - 1 reflex = 4 corners"
    # The reflex fillet's arc is centred a radius in from the notch on both axes
    # (r, r), so the sliver it fills is the part of the notch NEAREST the old
    # sharp corner, not a disc hugging the corner itself.
    assert inside(shape_both, (0.1, 0.1, h / 2)), "the reflex corner rounds INTO the notch, adding material"

    convex_only = _l_shape(w, h) + [{"id": "vf", "type": "verticalFillet", "radius": r, "onlyConvex": True}]
    errors, bodies = build(convex_only)
    assert not errors, errors
    shape_convex = only_body(bodies)
    assert_one_valid_solid(shape_convex)
    assert abs((before - vol(shape_convex)) - 5 * per_corner) < 1e-3 * per_corner, "only the 5 convex corners round"
    assert not inside(shape_convex, (0.1, 0.1, h / 2)), "onlyConvex leaves the reflex notch corner sharp"
    print(PASS, "onlyConvex leaves a reflex vertical edge untouched instead of filling its notch")


def test_vertical_fillet_needs_vertical_edges():
    errors, _ = build([
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "radius": 10, "x": 0, "y": 0}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new"},
        {"id": "vf", "type": "verticalFillet", "radius": 1},
    ])
    msg = error_for(errors, "vf")
    assert msg and "no edges run parallel" in msg, errors
    print(PASS, "a cylinder with no vertical edges is refused by name")


def main():
    print("Print toolbox: elephant-foot chamfer and vertical fillet")
    test_elephant_foot_removes_the_analytic_volume()
    test_elephant_foot_ignores_bottom_holes()
    test_elephant_foot_size_is_validated()
    test_vertical_fillet_removes_the_analytic_volume()
    test_vertical_fillet_only_convex_skips_the_reflex_edge()
    test_vertical_fillet_needs_vertical_edges()
    print("ALL PASS")


if __name__ == "__main__":
    main()
