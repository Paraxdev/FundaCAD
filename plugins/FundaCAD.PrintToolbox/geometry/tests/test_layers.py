"""Counterbore bridges and sacrificial layers. Run from sidecar/: uv run python ../plugins/FundaCAD.PrintToolbox/geometry/tests/test_layers.py"""

import math

import _bootstrap  # noqa: F401
from _docs import (
    assert_one_valid_solid, block, build, error_for, face_at, inside, only_body, vol, y_hole, z_cut,
)

PASS = "  ok"
CB_R = 6.0
BORE_R = 2.5
FLOOR = 5.0
LH = 0.2


def _counterbored():
    """A counterbore opening down onto the build plate side, with a through bore above its floor."""
    return block(30, 30, 20) + z_cut(CB_R, FLOOR, "sc", "ec") + z_cut(BORE_R, 20, "sb", "eb")


def _strip_in_disc(half_width, radius):
    a = half_width
    return 2 * (a * math.sqrt(radius * radius - a * a) + radius * radius * math.asin(a / radius))


def test_counterbore_bridge_layers():
    errors, bodies = build(_counterbored())
    assert not errors, errors
    before = vol(only_body(bodies))
    bore = math.pi * BORE_R ** 2
    layer_areas = [
        _strip_in_disc(BORE_R, CB_R) - bore,
        (2 * BORE_R) ** 2 - bore,
        8 * BORE_R ** 2 * math.tan(math.pi / 8) - bore,
    ]
    for count in (2, 3):
        feats = _counterbored() + [{"id": "cb", "type": "counterboreBridge", "faces": face_at((4, 0, FLOOR)),
                                    "layers": count}]
        errors, bodies = build(feats)
        assert not errors, errors
        shape = only_body(bodies)
        assert_one_valid_solid(shape)
        removed = before - vol(shape)
        want = LH * sum(layer_areas[:count])
        assert abs(removed - want) < 1e-3 * want, (count, removed, want)

        z1 = FLOOR + LH / 2
        assert not inside(shape, (0, 0, z1)), "the bore stays open in layer 1"
        assert not inside(shape, (CB_R - 0.3, 0, z1)), "layer 1 leaves a slot as wide as the bore, wall to wall"
        assert inside(shape, (0, BORE_R + 0.3, z1)), "layer 1 bridges beside the slot"
        assert inside(shape, (CB_R + 0.3, 0, z1)), "nothing is cut beyond the counterbore wall"

        z2 = FLOOR + 1.5 * LH
        assert inside(shape, (CB_R - 0.3, 0, z2)), "layer 2 bridges across the slot"
        assert not inside(shape, (BORE_R - 0.1, BORE_R - 0.1, z2)), "layer 2 leaves a square as wide as the bore"
        assert inside(shape, (BORE_R + 0.1, 0.0, z2)), "layer 2 stays closed outside the square"

        z3 = FLOOR + 2.5 * LH
        corner = (BORE_R * 0.98, BORE_R * 0.98, z3)
        assert inside(shape, corner), "the square's corner is closed again above the bridges"
        octagon_side = (BORE_R + 0.02) * math.cos(math.radians(22.5)), (BORE_R + 0.02) * math.sin(math.radians(22.5))
        open_in_3 = not inside(shape, (octagon_side[0] * 0.999, octagon_side[1] * 0.999, z3))
        assert open_in_3 == (count == 3), f"layer 3 octagon open={open_in_3} with {count} layers"
        assert inside(shape, (BORE_R + 0.2, 0, FLOOR + (count + 0.5) * LH)), "above the layers the part is unchanged"
    print(PASS, "counterbore bridges cut a wall-to-wall slot, then a square, then an octagon, one layer each")


def test_counterbore_bridge_turns_and_refuses():
    feats = _counterbored() + [{"id": "cb", "type": "counterboreBridge", "faces": face_at((4, 0, FLOOR)),
                                "angle": 90}]
    errors, bodies = build(feats)
    assert not errors, errors
    shape = only_body(bodies)
    z1 = FLOOR + LH / 2
    assert not inside(shape, (0, CB_R - 0.3, z1)), "a 90 degree turn runs the slot along Y"
    assert inside(shape, (CB_R - 0.3, 0, z1))

    pocket = block(30, 30, 20) + z_cut(CB_R, FLOOR, "sc", "ec")
    errors, _ = build(pocket + [{"id": "cb", "type": "counterboreBridge", "faces": face_at((4, 0, FLOOR))}])
    msg = error_for(errors, "cb")
    assert msg and "exactly one round bore" in msg, errors

    errors, _ = build(_counterbored() + [{"id": "cb", "type": "counterboreBridge", "faces": face_at((10, 10, 0))}])
    msg = error_for(errors, "cb")
    assert msg and "not a counterbore floor" in msg, errors

    plain = block(30, 30, 20) + z_cut(BORE_R, 20, "sb", "eb")
    errors, _ = build(plain + [{"id": "cb", "type": "counterboreBridge", "faces": face_at((10, 10, 20))}])
    msg = error_for(errors, "cb")
    assert msg and "not a counterbore floor" in msg, errors

    errors, _ = build(_counterbored() + [{"id": "cb", "type": "counterboreBridge", "faces": face_at((0, BORE_R, 10))}])
    msg = error_for(errors, "cb")
    assert msg and "curved" in msg, errors
    print(PASS, "the slot turns with its angle, and a floor with no bore, an outer face and a curved face are refused")


def _through():
    return block(20, 20, 10) + z_cut(BORE_R, 10, "sb", "eb")


def test_sacrificial_layer_from_the_hole_face():
    errors, bodies = build(_through())
    assert not errors, errors
    before = vol(only_body(bodies))
    for side, z0, sign in (("bottom", 0.0, 1), ("top", 10.0, -1)):
        feats = _through() + [{"id": "sl", "type": "sacrificialLayer", "faces": face_at((BORE_R, 0, 5)),
                               "side": side}]
        errors, bodies = build(feats)
        assert not errors, errors
        shape = only_body(bodies)
        assert_one_valid_solid(shape)
        assert inside(shape, (0, 0, z0 + sign * LH / 2)), f"the {side} opening is closed"
        assert not inside(shape, (0, 0, z0 + sign * 1.5 * LH)), "one layer only"
        assert not inside(shape, (0, 0, 10 - z0 - sign * LH / 2)), "the other end stays open"
        added = vol(shape) - before
        assert abs(added - math.pi * BORE_R ** 2 * LH) < 1e-3, (side, added)
    print(PASS, "a sacrificial layer closes the bottom opening by default, or the top one")


def test_sacrificial_layer_from_the_face_at_a_depth():
    feats = _through() + [{"id": "sl", "type": "sacrificialLayer", "faces": face_at((8, 8, 10)),
                           "depth": 3, "layers": 2}]
    errors, bodies = build(feats)
    assert not errors, errors
    shape = only_body(bodies)
    assert_one_valid_solid(shape)
    assert inside(shape, (0, 0, 10 - 3 - LH)), "the membrane sits 3 mm into the hole"
    assert inside(shape, (0, 0, 10 - 3 - 1.9 * LH)), "two layers thick"
    assert not inside(shape, (0, 0, 10 - 3 - 2.1 * LH))
    assert not inside(shape, (0, 0, 10 - 2.9)), "open above the membrane"
    print(PASS, "picking the face the hole opens onto puts the membrane at a depth below it")


def test_sacrificial_layer_on_a_counterbore_floor():
    feats = _counterbored() + [{"id": "sl", "type": "sacrificialLayer", "faces": face_at((0, BORE_R, 12))}]
    errors, bodies = build(feats)
    assert not errors, errors
    shape = only_body(bodies)
    assert_one_valid_solid(shape)
    assert inside(shape, (0, 0, FLOOR + LH / 2)), "the bore is closed where it leaves the counterbore"
    assert not inside(shape, (0, 0, FLOOR - 0.5)), "the counterbore itself stays open"
    print(PASS, "on a counterbored hole the bore's bottom end is the one closed")


def test_sacrificial_layer_refusals():
    errors, _ = build(_through() + [{"id": "sl", "type": "sacrificialLayer", "faces": face_at((BORE_R, 0, 5)),
                                     "depth": 9.9}])
    msg = error_for(errors, "sl")
    assert msg and "runs past the end" in msg, errors
    errors, _ = build(_through() + [{"id": "sl", "type": "sacrificialLayer", "faces": face_at((10, 0, 5))}])
    msg = error_for(errors, "sl")
    assert msg and "no round hole opens" in msg, errors
    errors, _ = build(_through() + [{"id": "sl", "type": "sacrificialLayer", "faces": face_at((BORE_R, 0, 5)),
                                     "layers": 2.5}])
    msg = error_for(errors, "sl")
    assert msg and "whole number" in msg, errors
    errors, _ = build(block(30, 20, 20) + y_hole(3, 10, length=100) + [
        {"id": "sl", "type": "sacrificialLayer", "faces": face_at((0, 0, 13)), "depth": 2}])
    assert not errors, errors
    print(PASS, "too deep, a face with no hole, and a fractional layer count are refused by name")


def main():
    print("Print toolbox: layers")
    test_counterbore_bridge_layers()
    test_counterbore_bridge_turns_and_refuses()
    test_sacrificial_layer_from_the_hole_face()
    test_sacrificial_layer_from_the_face_at_a_depth()
    test_sacrificial_layer_on_a_counterbore_floor()
    test_sacrificial_layer_refusals()
    print("ALL PASS")


if __name__ == "__main__":
    main()
