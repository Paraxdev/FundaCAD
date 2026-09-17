"""Teardrop and roof bridge. Run from sidecar/: uv run python ../plugins/FundaCAD.PrintToolbox/geometry/tests/test_holes.py"""

import math

import _bootstrap  # noqa: F401
import ptb_occ as g
import ptb_read
from geom_select import resolve_faces
from _docs import (
    assert_one_valid_solid, block, build, error_for, face_at, inside, only_body, vol, y_hole, z_cut,
)

PASS = "  ok"
R = 3.0
Z = 10.0
L = 20.0


def _base():
    return block(30, L, 20) + y_hole(R, Z)


def _shoelace(pts):
    s = 0.0
    for i, (x0, y0) in enumerate(pts):
        x1, y1 = pts[(i + 1) % len(pts)]
        s += x0 * y1 - x1 * y0
    return abs(s) / 2


def _plain_volume():
    errors, bodies = build(_base())
    assert not errors, errors
    return vol(only_body(bodies))


def test_teardrop_removes_the_analytic_cap():
    before = _plain_volume()
    for angle in (45.0, 30.0, 60.0):
        feats = _base() + [{"id": "td", "type": "teardropHole", "faces": face_at((0, 0, Z + R)),
                            "angle": angle}]
        errors, bodies = build(feats)
        assert not errors, errors
        shape = only_body(bodies)
        assert_one_valid_solid(shape)
        th = math.radians(angle)
        cap = R * R * (1 / math.tan(th) - (math.pi / 2 - th))
        removed = before - vol(shape)
        assert abs(removed - cap * L) < 1e-3 * cap * L + 1e-4, (angle, removed, cap * L)
        tip = R / math.sin(th)
        assert not inside(shape, (0, 0, Z + tip - 0.05)), "just under the tip should be air"
        assert inside(shape, (0, 0, Z + tip + 0.05)), "just above the tip should be material"
        assert inside(shape, (0, 0, Z - R - 0.05)), "the bottom of the hole must not change"
    print(PASS, "a teardrop removes r^2 (cot a - (pi/2 - a)) per mm, at 30, 45 and 60 degrees")


def test_teardrop_follows_the_build_direction():
    before = _plain_volume()
    feats = _base() + [{"id": "td", "type": "teardropHole", "faces": face_at((0, 0, Z + R)),
                        "buildDir": "+X"}]
    errors, bodies = build(feats)
    assert not errors, errors
    shape = only_body(bodies)
    assert_one_valid_solid(shape)
    tip = R / math.sin(math.radians(45))
    assert not inside(shape, (tip - 0.05, 0, Z)), "the roof should point along +X"
    assert inside(shape, (0, 0, Z + R + 0.2)), "nothing should be cut above the hole"
    assert abs((before - vol(shape)) - R * R * (1 - math.pi / 4) * L) < 1e-2
    print(PASS, "the roof points along the build direction, projected across the hole")


def test_tilted_hole_points_its_roof_up():
    tilted = _base() + [{"id": "mv", "type": "move", "rx": 30}]
    errors, bodies = build(tilted)
    assert not errors, errors
    shape = only_body(bodies)
    before = vol(shape)
    cyl = next(fc for fc in shape.faces() if ptb_read.cylinder_of(fc) is not None)
    o, a, r, t0, t1 = ptb_read.cylinder_of(cyl)
    assert abs(abs(a[2]) - 0.5) < 1e-6, f"expected a 30 degree tilt, axis {a}"
    center = g.lin(o, ((t0 + t1) / 2, a))
    up = g.unit(g.sub((0, 0, 1), g.mul(a, a[2])))
    pick = g.lin(center, (R, up))
    errors, bodies = build(tilted + [{"id": "td", "type": "teardropHole", "faces": face_at(pick)}])
    assert not errors, errors
    after = only_body(bodies)
    assert_one_valid_solid(after)
    tip = R / math.sin(math.radians(45))
    assert not inside(after, g.lin(center, (tip - 0.05, up))), "the roof should lean toward +Z"
    assert inside(after, g.lin(center, (tip + 0.05, up)))
    assert abs((before - vol(after)) - R * R * (1 - math.pi / 4) * L) < 1e-2
    print(PASS, "a tilted hole's roof points toward the build direction projected across its axis")


def test_flat_roof_height():
    before = _plain_volume()
    for extra in (0.0, 0.5):
        feats = _base() + [{"id": "td", "type": "teardropHole", "faces": face_at((0, 0, Z + R)),
                            "roof": "flat", "flatHeight": extra}]
        errors, bodies = build(feats)
        assert not errors, errors
        shape = only_body(bodies)
        assert_one_valid_solid(shape)
        top = Z + R + extra
        assert not inside(shape, (0, 0, top - 0.05)), f"under the flat roof should be air ({extra})"
        assert inside(shape, (0, 0, top + 0.05)), f"above the flat roof should be material ({extra})"
        s = math.sqrt(0.5)
        h = R + extra
        tip = R / s
        t = (h - R * s) / (tip - R * s)
        p1 = (R * s, R * s)
        q1 = (p1[0] + (0 - p1[0]) * t, p1[1] + (tip - p1[1]) * t)
        poly = [(0, 0), p1, q1, (-q1[0], q1[1]), (-p1[0], p1[1])]
        area = _shoelace(poly) - (math.pi / 4) * R * R
        removed = before - vol(shape)
        assert abs(removed - area * L) < 1e-3 * area * L + 1e-4, (extra, removed, area * L)
    print(PASS, "the flat roof sits at the top of the hole, or the chosen height above it")


def test_vertical_hole_is_refused():
    feats = block(30, 30, 20) + z_cut(3, 20, "sv", "ev") + [
        {"id": "td", "type": "teardropHole", "faces": face_at((3, 0, 10))}]
    errors, _ = build(feats)
    msg = error_for(errors, "td")
    assert msg and "runs along the build direction" in msg, errors
    print(PASS, "a hole along the build direction is refused:", msg)


def test_non_cylinder_and_boss_are_refused():
    errors, _ = build(_base() + [{"id": "td", "type": "teardropHole", "faces": face_at((0, 0, 20))}])
    msg = error_for(errors, "td")
    assert msg and "not cylindrical" in msg, errors
    boss = block(30, 30, 10) + [
        {"id": "sb", "type": "sketch", "plane": "XZ",
         "entities": [{"type": "circle", "radius": 3, "x": 0, "y": 20}]},
        {"id": "eb", "type": "extrude", "sketch": "sb", "distance": 10, "symmetric": True,
         "operation": "join"},
    ]
    errors, bodies = build(boss)
    assert not errors, errors
    errors, _ = build(boss + [{"id": "td", "type": "teardropHole", "faces": face_at((0, 0, 23))}])
    msg = error_for(errors, "td")
    assert msg and "boss" in msg, errors
    print(PASS, "a flat face and a boss are refused by name")


def test_teardrop_on_two_holes_and_both_halves():
    feats = block(40, L, 20) + [
        {"id": "sh", "type": "sketch", "plane": "XZ",
         "entities": [{"type": "circle", "radius": R, "x": -8, "y": Z},
                      {"type": "circle", "radius": R, "x": 8, "y": Z}]},
        {"id": "eh", "type": "extrude", "sketch": "sh", "distance": 100, "symmetric": True,
         "operation": "cut"},
    ]
    errors, bodies = build(feats)
    assert not errors, errors
    before = vol(only_body(bodies))
    # Each of these holes builds as two half-length faces, so the left hole is picked through both.
    picks = [face_at((-8, 5, Z + R)), face_at((8, 5, Z + R)), face_at((-8, -5, Z - R))]
    plain = only_body(bodies)
    holes = ptb_read.holes_from_faces(plain, resolve_faces(plain, picks), "test")
    assert len(holes) == 2, holes
    assert all(abs((h["t1"] - h["t0"]) - L) < 1e-6 for h in holes), holes
    errors, bodies = build(feats + [{"id": "td", "type": "teardropHole", "faces": picks}])
    assert not errors, errors
    shape = only_body(bodies)
    assert_one_valid_solid(shape)
    cap = R * R * (1 - math.pi / 4)
    removed = before - vol(shape)
    assert abs(removed - 2 * cap * L) < 1e-2, (removed, 2 * cap * L)
    print(PASS, "two holes in one feature, the same hole picked twice is cut once")


def test_blind_hole_stops_at_its_floor():
    feats = block(30, 20, 20) + [
        {"id": "sh", "type": "sketch", "plane": "XZ",
         "entities": [{"type": "circle", "radius": R, "x": 0, "y": Z}]},
        {"id": "eh", "type": "extrude", "sketch": "sh", "distance": -8, "operation": "cut"},
    ]
    errors, bodies = build(feats)
    assert not errors, errors
    shape = only_body(bodies)
    ys = [p for p in (-9.9, -2.1, 2.1, 9.9) if not inside(shape, (0, p, Z))]
    assert len(ys) == 1, f"expected a blind hole open at one end, air at {ys}"
    before = vol(shape)
    errors, bodies = build(feats + [{"id": "td", "type": "teardropHole", "faces": face_at((0, ys[0], Z + R))}])
    assert not errors, errors
    after = only_body(bodies)
    assert_one_valid_solid(after)
    removed = before - vol(after)
    assert abs(removed - R * R * (1 - math.pi / 4) * 8) < 1e-2, removed
    print(PASS, "a blind hole's teardrop stops at its floor")


def test_roof_bridge_volume_and_height():
    before = _plain_volume()
    for extra in (0.0, 0.6):
        feats = _base() + [{"id": "rb", "type": "roofBridge", "faces": face_at((0, 0, Z + R)),
                            "height": extra}]
        errors, bodies = build(feats)
        assert not errors, errors
        shape = only_body(bodies)
        assert_one_valid_solid(shape)
        area = 2 * R * (R + extra) - math.pi * R * R / 2
        removed = before - vol(shape)
        assert abs(removed - area * L) < 1e-3 * area * L + 1e-4, (extra, removed, area * L)
        assert not inside(shape, (R - 0.05, 0, Z + R + extra - 0.05)), "the corner under the bridge is open"
        assert inside(shape, (0, 0, Z + R + extra + 0.05)), "the bridge is material"
        assert inside(shape, (R + 0.05, 0, Z + 0.5)), "the walls stay at the hole's width"
    print(PASS, "a roof bridge squares the top of the hole at the chosen height")


def main():
    print("Print toolbox: holes")
    test_teardrop_removes_the_analytic_cap()
    test_teardrop_follows_the_build_direction()
    test_tilted_hole_points_its_roof_up()
    test_flat_roof_height()
    test_vertical_hole_is_refused()
    test_non_cylinder_and_boss_are_refused()
    test_teardrop_on_two_holes_and_both_halves()
    test_blind_hole_stops_at_its_floor()
    test_roof_bridge_volume_and_height()
    print("ALL PASS")


if __name__ == "__main__":
    main()
