"""Press/Pull as a boolean: pushing through, and an explicit operation.

Auto keeps the old behaviour except that a push is no longer capped short of
going through, so pushing a boss's top face down past the plate under it cuts a
hole. An explicit operation extrudes the face straight out, curved or not, and
combines the prism the way an extrude does: joined into or cut from whatever
bodies it reaches, or left as a new body.

Run: uv run python tests/test_presspull_modes.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from builder import rebuild

PASS = "  ok"


def rect(fid, w, h, x=0, y=0, plane="XY"):
    return {"id": fid, "type": "sketch", "plane": plane,
            "entities": [{"type": "rectangle", "width": w, "height": h, "x": x, "y": y}]}


def face(point):
    return {"kind": "face", "by": "nearest", "point": point}


def build(features):
    _p, errors, bodies = rebuild({"parameters": {}, "features": features})
    return errors, bodies


PLATE_WITH_BOSS = [
    rect("s1", 40, 40), {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 10, "operation": "new"},
    {"id": "s2", "type": "sketch", "plane": {"origin": [0, 0, 10], "normal": [0, 0, 1], "xdir": [1, 0, 0]},
     "entities": [{"type": "rectangle", "width": 10, "height": 10, "x": 0, "y": 0}]},
    {"id": "e2", "type": "extrude", "sketch": "s2", "distance": 5, "operation": "join"},
]


def test_a_push_goes_all_the_way_through():
    pp = {"id": "p", "type": "press-pull", "face": face([0, 0, 15]), "distance": -25, "operation": "cut"}
    errors, bodies = build(PLATE_WITH_BOSS + [pp])
    assert not errors, errors
    vol = bodies[0]["shape"].volume
    assert abs(vol - (40 * 40 * 10 - 10 * 10 * 10)) < 1e-3, vol
    print(PASS, "pushing the boss down past the plate cuts a square hole through it")


def test_new_body_join_cut_and_intersect():
    two = [
        rect("a", 20, 20), {"id": "ea", "type": "extrude", "sketch": "a", "distance": 20, "operation": "new"},
        rect("b", 20, 20, x=30), {"id": "eb", "type": "extrude", "sketch": "b", "distance": 20, "operation": "new"},
    ]
    side = face([10, 0, 10])  # box a's +X face, facing box b 10mm away

    errors, bodies = build(two + [{"id": "p", "type": "press-pull", "face": side, "distance": 15, "mode": "new"}])
    assert not errors and len(bodies) == 3, (errors, len(bodies))

    errors, bodies = build(two + [{"id": "p", "type": "press-pull", "face": side, "distance": 15, "mode": "join"}])
    assert not errors and len(bodies) == 1, (errors, len(bodies))
    assert abs(bodies[0]["shape"].volume - (2 * 8000 + 10 * 20 * 20)) < 1e-3, bodies[0]["shape"].volume

    errors, bodies = build(two + [{"id": "p", "type": "press-pull", "face": side, "distance": 15, "mode": "cut"}])
    assert not errors, errors
    vols = sorted(round(b["shape"].volume, 3) for b in bodies)
    assert vols == [6000.0, 8000.0], vols

    errors, bodies = build(two + [{"id": "p", "type": "press-pull", "face": side, "distance": -5, "mode": "intersect"}])
    assert not errors, errors
    vols = sorted(round(b["shape"].volume, 3) for b in bodies)
    assert vols == [2000.0, 8000.0], vols
    print(PASS, "new body, join and cut reach the neighbouring box, intersect keeps the overlap")


def test_a_curved_face_extrudes_straight():
    rounded = [
        rect("s", 40, 40), {"id": "e", "type": "extrude", "sketch": "s", "distance": 20, "operation": "new"},
        {"id": "f", "type": "fillet", "radius": 8, "edges": {"kind": "edge", "by": "nearest", "point": [20, 0, 20]}},
    ]
    errors, base = build(rounded)
    assert not errors, errors
    v0 = base[0]["shape"].volume
    blend = [17.66, 0, 17.66]  # on the round, halfway
    errors, bodies = build(rounded + [{"id": "p", "type": "press-pull", "face": face(blend), "distance": 5, "mode": "join"}])
    assert not errors, errors
    assert bodies[0]["shape"].is_valid and bodies[0]["shape"].volume > v0, bodies[0]["shape"].volume
    errors, bodies = build(rounded + [{"id": "p", "type": "press-pull", "face": face(blend), "distance": -5, "mode": "cut"}])
    assert not errors, errors
    assert bodies[0]["shape"].is_valid and bodies[0]["shape"].volume < v0
    print(PASS, "a fillet's round face extrudes straight out as a join and in as a cut")


if __name__ == "__main__":
    try:
        test_a_push_goes_all_the_way_through()
        test_new_body_join_cut_and_intersect()
        test_a_curved_face_extrudes_straight()
        print("\nALL PASS")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
