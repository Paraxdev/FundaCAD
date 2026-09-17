"""Which seams the viewport draws.

A cylinder's wrap-around seam is bookkeeping and stays hidden. But when that seam
lands exactly on the line where the cylinder meets another face, the same edge is
also a real crease between two faces, and hiding it lost one side of every
patterned leg on a round wall: nothing to see and nothing to click to fillet.

Run: uv run python tests/test_seam_display.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from builder import rebuild
from tessellate import edge_polylines_by_body

PASS = "  ok"
R = 4.245828802487684


def _shown_at(bodies, x, y):
    return [pl["points"] for pl in edge_polylines_by_body(bodies)
            if all(abs(q[0] - x) < 0.05 and abs(q[1] - y) < 0.05 for q in pl["points"])]


def test_a_plain_cylinder_seam_stays_hidden():
    feats = [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "id": "a", "x": 0, "y": 0, "radius": 10}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 20, "operation": "new"},
    ]
    _p, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert not errors, errors
    seam = [e for e in bodies[0]["shape"].edges() if e.geom_type.name == "LINE"]
    assert seam, "precondition: the cylinder has a seam edge"
    m = seam[0].position_at(0.5)
    assert not _shown_at(bodies, m.X, m.Y), "a plain seam is drawn"
    print(PASS, "a plain cylinder's seam is not drawn")


def test_a_seam_on_a_junction_is_drawn():
    # The leg's seam runs through (30, -40), which is on the R50 wall.
    feats = [
        {"id": "s1", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "id": "a", "x": 0, "y": 0, "radius": 50}]},
        {"id": "e1", "type": "extrude", "sketch": "s1", "distance": 20, "operation": "new"},
        {"id": "s2", "type": "sketch", "plane": "XY", "entities": [{"type": "circle", "id": "b", "x": 30 - R, "y": -40, "radius": R}]},
        {"id": "e2", "type": "extrude", "sketch": "s2", "distance": 30, "operation": "join"},
    ]
    _p, errors, bodies = rebuild({"parameters": {}, "features": feats})
    assert not errors, errors
    shown = _shown_at(bodies, 30, -40)
    assert len(shown) == 1, f"expected only the junction below the wall top, got {shown}"
    zs = sorted(q[2] for q in shown[0])
    assert abs(zs[0]) < 1e-6 and abs(zs[-1] - 20) < 1e-6, zs
    f = {"id": "f", "type": "fillet", "radius": 2, "edges": {"kind": "edge", "by": "nearest", "point": [30, -40, 10]}}
    _p, errors, filleted = rebuild({"parameters": {}, "features": feats + [f]})
    assert not errors and filleted[0]["shape"].volume > bodies[0]["shape"].volume, errors
    print(PASS, "a seam lying on the junction is drawn, and fillets")


def test_a_fillets_borders_are_tagged_smooth_and_its_corners_are_not():
    feats = [
        {"id": "s", "type": "sketch", "plane": "XY", "entities": [{"type": "rectangle", "id": "a", "x": 0, "y": 0, "width": 40, "height": 30}]},
        {"id": "e", "type": "extrude", "sketch": "s", "distance": 20, "operation": "new"},
    ]
    _p, errors, plain = rebuild({"parameters": {}, "features": feats})
    assert not errors, errors
    assert not any(pl.get("smooth") for pl in edge_polylines_by_body(plain)), "a box has no tangent edges"
    f = {"id": "f", "type": "fillet", "radius": 5, "edges": {"kind": "edge", "by": "nearest", "point": [20, 0, 20]}}
    _p, errors, bodies = rebuild({"parameters": {}, "features": feats + [f]})
    assert not errors, errors
    lines = edge_polylines_by_body(bodies)
    smooth = [pl for pl in lines if pl.get("smooth")]
    # The round meets the top and the side along two lines; its two ends are
    # creases against the front and back faces.
    assert len(smooth) == 2, [pl["points"][0] for pl in smooth]
    for pl in smooth:
        assert all(abs(q[1]) <= 15 + 1e-6 for q in pl["points"])
        assert {round(pl["points"][0][1]), round(pl["points"][-1][1])} == {-15, 15}
    print(PASS, "a fillet's two borders are tagged smooth, its ends and the box's corners are not")


if __name__ == "__main__":
    try:
        test_a_plain_cylinder_seam_stays_hidden()
        test_a_seam_on_a_junction_is_drawn()
        test_a_fillets_borders_are_tagged_smooth_and_its_corners_are_not()
        print("\nALL PASS")
    except Exception:
        traceback.print_exc()
        sys.exit(1)
