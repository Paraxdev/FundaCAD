"""Zip-tie channel. Run from sidecar/: uv run python ../plugins/FundaCAD.PrintToolbox/geometry/tests/test_zip.py"""

import _bootstrap  # noqa: F401
from _docs import assert_one_valid_solid, block, build, error_for, face_at, inside, only_body, vol, y_hole

PASS = "  ok"
W, H, INSET, SPAN = 4.0, 2.0, 5.0, 10.0


def test_channel_removes_the_analytic_volume():
    errors, bodies = build(block(30, 30, 10))
    assert not errors, errors
    before = vol(only_body(bodies))
    feats = block(30, 30, 10) + [{"id": "zt", "type": "zipTieChannel", "faces": face_at((0, 0, 10)),
                                  "channelWidth": W, "channelHeight": H, "insetDepth": INSET, "span": SPAN}]
    errors, bodies = build(feats)
    assert not errors, errors
    shape = only_body(bodies)
    assert_one_valid_solid(shape)
    want = W * H * (2 * INSET + SPAN - H)
    removed = before - vol(shape)
    assert abs(removed - want) < 1e-6 * want + 1e-6, (removed, want)

    assert not inside(shape, (0, 0, 10 - (INSET - H / 2))), "the tunnel is open at its centre"
    assert inside(shape, (0, 0, 9.9)), "the face above the tunnel, away from the slots, is intact"
    assert inside(shape, (0, SPAN, 5)), "nothing is cut far from the channel"
    print(PASS, "a zip-tie channel removes width x height x (2 x inset + span - height)")


def test_span_turns_with_the_angle():
    feats = block(30, 30, 10) + [{"id": "zt", "type": "zipTieChannel", "faces": face_at((0, 0, 10)),
                                  "channelWidth": W, "channelHeight": H, "insetDepth": INSET, "span": SPAN,
                                  "angle": 90}]
    errors, bodies = build(feats)
    assert not errors, errors
    shape = only_body(bodies)
    z = 10 - (INSET - H / 2)
    assert not inside(shape, (0, 0, z)), "the tunnel still runs under the face centre"
    assert not inside(shape, (0, 3.5, z)), "at 90 degrees the tunnel now runs along Y"
    assert inside(shape, (3.5, 0, z)), "and no longer along X"
    print(PASS, "the channel's span turns with its angle")


def test_breakthrough_is_refused_unless_allowed():
    thin = block(30, 30, 5.05)
    feats = thin + [{"id": "zt", "type": "zipTieChannel", "faces": face_at((0, 0, 5.05)),
                     "channelWidth": W, "channelHeight": H, "insetDepth": INSET, "span": SPAN}]
    errors, _ = build(feats)
    msg = error_for(errors, "zt")
    assert msg and "break through" in msg, errors

    allowed = thin + [{"id": "zt", "type": "zipTieChannel", "faces": face_at((0, 0, 5.05)),
                       "channelWidth": W, "channelHeight": H, "insetDepth": INSET, "span": SPAN,
                       "allowBreakthrough": True}]
    errors, bodies = build(allowed)
    assert not errors, errors
    assert_one_valid_solid(only_body(bodies))
    print(PASS, "a channel that would break through the far side is refused unless allowed")


def test_span_must_exceed_channel_height():
    feats = block(30, 30, 10) + [{"id": "zt", "type": "zipTieChannel", "faces": face_at((0, 0, 10)),
                                  "channelHeight": 3, "span": 3}]
    errors, _ = build(feats)
    msg = error_for(errors, "zt")
    assert msg and "greater than the channel height" in msg, errors
    print(PASS, "a span no longer than the channel height is refused")


def test_curved_face_is_refused():
    feats = block(30, 20, 20) + y_hole(3, 10, length=100) + [
        {"id": "zt", "type": "zipTieChannel", "faces": face_at((3, 0, 10))}]
    errors, _ = build(feats)
    msg = error_for(errors, "zt")
    assert msg and "flat face" in msg, errors
    print(PASS, "a curved face is refused by name")


def main():
    print("Print toolbox: zip-tie channel")
    test_channel_removes_the_analytic_volume()
    test_span_turns_with_the_angle()
    test_breakthrough_is_refused_unless_allowed()
    test_span_must_exceed_channel_height()
    test_curved_face_is_refused()
    print("ALL PASS")


if __name__ == "__main__":
    main()
