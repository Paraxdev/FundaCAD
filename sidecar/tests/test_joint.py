"""A joint positions one body against another by aligning a mate connector on
each, and re-resolves those connectors every rebuild so the assembly follows the
parts.

The moving body is rigidly re-placed so its connector meets the fixed one; no
other body moves. Two mating faces meet flush (their outward normals opposed) by
default; `offset` then slides the moving body along the mate axis and `angle`
spins it about that axis, the placements a slider and a revolute joint drive.

CONTROLS: the fixed body never moves; `flush` puts the parts on the same side
instead of face to face; and a mate reference that no longer resolves leaves the
moving body exactly where it was rather than failing the build.

Run: uv run python tests/test_joint.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

from builder import rebuild

PASS = "  ok"

# body1 = a 20mm cube centred on the origin (top face at z=+10). body2 = a 6mm
# cube, created at the origin then MOVED out to (50,0,0), so the joint has to
# actually relocate it, not merely leave it where a lucky sketch put it.
def base_features(*joint):
    return [
        {"id": "a", "type": "box", "length": 20, "width": 20, "height": 20},
        {"id": "b", "type": "box", "length": 6, "width": 6, "height": 6},
        {"id": "mb", "type": "move", "bodies": ["body2"], "dx": 50},
        *joint,
    ]


def build(*joint):
    _part, errors, bodies = rebuild({"parameters": {}, "features": base_features(*joint)})
    return {b["id"]: b for b in bodies}, errors


def face_at(point, body):
    return {"kind": "face", "by": "nearest", "point": point, "body": body}


# body2's bottom face (centre) at its pre-joint home, and body1's top face.
B2_BOTTOM = [50.0, 0.0, -3.0]
B1_TOP = [0.0, 0.0, 10.0]


def _joint(**kw):
    return {"id": "j", "type": "joint", "moving": "body2",
            "mate": {"body": "body2", "face": face_at(B2_BOTTOM, "body2")},
            "to": {"body": "body1", "face": face_at(B1_TOP, "body1")}, **kw}


def test_a_face_mate_stacks_one_body_on_another():
    """The headline: body2's bottom face lands on body1's top face, so body2 sits
    directly on top, centred over the connector, and body1 does not budge."""
    by, errors = build(_joint())
    assert errors == [], errors
    bb = by["body2"]["shape"].bounding_box()
    assert abs(bb.min.Z - 10.0) < 1e-6, f"body2 should rest on the top face z=10, got zmin {bb.min.Z}"
    assert abs(bb.max.Z - 16.0) < 1e-6, f"a 6mm cube on z=10 tops out at 16, got {bb.max.Z}"
    c = by["body2"]["shape"].center()
    assert abs(c.X) < 1e-6 and abs(c.Y) < 1e-6, f"body2 should centre over the mate, got ({c.X},{c.Y})"
    # the fixed body is untouched, to the micron
    fb = by["body1"]["shape"].bounding_box()
    assert abs(fb.min.Z + 10.0) < 1e-6 and abs(fb.max.Z - 10.0) < 1e-6, (fb.min.Z, fb.max.Z)
    print(PASS, "a face mate stacks body2 on body1 and leaves body1 put")


def test_offset_slides_along_the_mate_axis():
    """A slider's degree of freedom: offset lifts body2 straight up the mate
    axis, so it floats 5mm above the face instead of resting on it."""
    by, _ = build(_joint(offset=5))
    bb = by["body2"]["shape"].bounding_box()
    assert abs(bb.min.Z - 15.0) < 1e-6, f"offset 5 should lift the base to z=15, got {bb.min.Z}"
    print(PASS, "offset slides the moving body along the mate axis")


def test_angle_spins_about_the_mate_axis():
    """A revolute's degree of freedom: a 45 degree turn about the mate axis
    swings the 6mm cube's corner out to its half-diagonal, ~4.243mm."""
    straight = build(_joint())[0]["body2"]["shape"].bounding_box()
    assert abs(straight.max.X - 3.0) < 1e-6, straight.max.X  # square-on: half-width 3
    turned = build(_joint(angle=45))[0]["body2"]["shape"].bounding_box()
    assert abs(turned.max.X - 4.2426) < 1e-3, f"a 45 turn should reach ~4.243, got {turned.max.X}"
    print(PASS, "angle spins the moving body about the mate axis")


def test_flush_puts_the_parts_on_the_same_side():
    """CONTROL for the facing default: with `flush`, the connector axes point the
    same way instead of opposing, so body2 drops through onto the other side of
    the top face (base at z=4, interpenetrating), proving the default really is
    the half turn that makes two faces meet."""
    by, _ = build(_joint(flush=True))
    bb = by["body2"]["shape"].bounding_box()
    assert abs(bb.max.Z - 10.0) < 1e-6 and abs(bb.min.Z - 4.0) < 1e-6, (bb.min.Z, bb.max.Z)
    print(PASS, "flush aligns the axes the same way (control on the facing default)")


def test_a_stale_mate_reference_leaves_the_body_in_place():
    """CONTROL: a mate whose fixed side names a body that does not exist must not
    fail the build or teleport the part, it leaves body2 exactly where it was
    (centred at (50,0,0)), and records a diagnostic instead."""
    stale = {"id": "j", "type": "joint", "moving": "body2",
             "mate": {"body": "body2", "face": face_at(B2_BOTTOM, "body2")},
             "to": {"body": "body9", "face": face_at([0, 0, 0], "body9")}}
    by, errors = build(stale)
    assert errors == [], f"a stale mate should skip softly, not error: {errors}"
    c = by["body2"]["shape"].center()
    assert abs(c.X - 50.0) < 1e-6 and abs(c.Y) < 1e-6 and abs(c.Z) < 1e-6, \
        f"body2 moved on a stale mate, it should have stayed at (50,0,0), got ({c.X},{c.Y},{c.Z})"
    print(PASS, "a stale mate reference leaves the moving body in place")


def main():
    test_a_face_mate_stacks_one_body_on_another()
    test_offset_slides_along_the_mate_axis()
    test_angle_spins_about_the_mate_axis()
    test_flush_puts_the_parts_on_the_same_side()
    test_a_stale_mate_reference_leaves_the_body_in_place()
    print("ALL PASS")


if __name__ == "__main__":
    main()
