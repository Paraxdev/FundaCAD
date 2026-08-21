"""Selecting one area of a profile must build that area, not the whole profile.

A sketch drawn on a face routinely runs off it, and the overlay splits it there
so the part with material behind it and the part hanging off pick separately.
Nothing carried that split to the builder, so a point naming one area resolved to
the whole profile: a join grew a slab nobody selected, and a cut with the leftover
area took the join with it — the reported "the whole sketch extrudes", then "it
vanishes completely without a warning".

The document below is the reported one, rebuilt from primitives: a 60x60x34.664
block, and a 65.336 x 16.666 rectangle on its front face running 15.336 below the
bottom edge and 15.336 above the top one, so the model's outline cuts it into
three.

Run: uv run python tests/test_region_footprint.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

from build123d import Edge, Face, Plane, Vector

from builder import _region_cells, _region_face_at, rebuild, _solid_volume
from face_footprint import (
    bbox_straddles_plane,
    edge_lies_in_plane,
    edges_in_plane,
    plane_tolerance,
    split_faces,
)

PASS = "  ok"

W, D, H = 60.0, 60.0, 34.664
OVER = 15.336              # how far the rectangle runs past each end of the face
RW = 16.666                # rectangle width across the face
FRONT = Plane(origin=(0, -D / 2, 0), z_dir=(0, -1, 0), x_dir=(0, 0, 1))

# The three areas the outline cuts the rectangle into, by world Z.
BELOW = [0.0, -D / 2, -OVER / 2]
ONFACE = [0.0, -D / 2, H / 2]
ABOVE = [0.0, -D / 2, H + OVER / 2]

SKETCH = {
    "id": "f3",
    "type": "sketch",
    "plane": {"origin": [0, -D / 2, 0], "normal": [0, -1, 0], "xdir": [0, 0, 1]},
    "entities": [{
        "type": "rectangle", "id": "e2",
        "width": H + 2 * OVER, "height": RW, "x": H / 2, "y": 0,
    }],
}
BLOCK = [
    {"id": "f1", "type": "sketch", "plane": "XY",
     "entities": [{"type": "rectangle", "id": "e0", "width": W, "height": D, "x": 0, "y": 0}]},
    {"id": "f2", "type": "extrude", "sketch": "f1", "distance": H,
     "operation": "new", "regions": [[0, 0, 0]], "hiddenBodies": []},
]


def doc(*extra):
    return {"parameters": {}, "paramDefs": {}, "version": 8,
            "features": [*BLOCK, SKETCH, *extra]}


def build(*extra):
    part, errs, bodies = rebuild(doc(*extra), diagnostics=[])
    return part, errs


def block_volume():
    return W * D * H


# --- the split itself ---------------------------------------------------------

def test_the_outline_cuts_the_profile_into_three():
    part, errs = build()
    assert errs == [], errs
    ctx = _Ctx(part)
    cells = _region_cells(_entry(), ctx)
    zs = sorted(round(bb.min.Z, 3) for _, bb in cells)
    assert len(cells) == 3, [f.area for f, _ in cells]
    assert zs == [-OVER, 0.0, H], zs
    print(PASS, "the block's outline cuts the profile into three areas")


def test_a_point_picks_its_own_area_not_the_profile():
    part, _ = build()
    cells = _region_cells(_entry(), _Ctx(part))
    for name, p, lo, hi in (("below", BELOW, -OVER, 0.0),
                            ("on the face", ONFACE, 0.0, H),
                            ("above", ABOVE, H, H + OVER)):
        fc = _region_face_at(cells, Vector(*p))
        bb = fc.bounding_box()
        assert abs(bb.min.Z - lo) < 1e-6 and abs(bb.max.Z - hi) < 1e-6, (name, bb.min.Z, bb.max.Z)
    print(PASS, "each area's point picks that area")


def test_a_sketch_with_no_model_behind_it_is_left_whole():
    """CONTROL that must fail if the split ran on everything. A profile on a datum
    plane has no outline to be cut by, and 'no footprint' has to stay different
    from 'a face with no area' or every area there reads as unsupported."""
    away = {**SKETCH, "plane": {"origin": [0, 200, 0], "normal": [0, -1, 0], "xdir": [0, 0, 1]}}
    part, errs = rebuild(
        {"parameters": {}, "paramDefs": {}, "version": 8, "features": [*BLOCK, away]},
        diagnostics=[],
    )[0], []
    ctx = _Ctx(part)
    cells = _region_cells(_entry(away), ctx)
    assert len(cells) == 1, [f.area for f, _ in cells]
    print(PASS, "a profile with nothing behind it stays one area (control)")


# --- what the features then build ---------------------------------------------

def test_join_grows_only_the_selected_areas():
    """The reported join: the on-face area and the one above it, NOT the one below.
    The old answer extruded the whole rectangle, which is 15.336 mm of slab
    hanging under the block that nobody asked for."""
    join = {"id": "f4", "type": "extrude", "sketch": "f3", "distance": 15.352,
            "operation": "join", "regions": [ONFACE, ABOVE], "hiddenBodies": []}
    part, errs = build(join)
    assert errs == [], errs
    bb = part.bounding_box()
    assert abs(bb.min.Z) < 1e-6, f"the unselected area below still extruded (z {bb.min.Z})"
    assert abs(bb.max.Z - (H + OVER)) < 1e-6, bb.max.Z
    grew = _solid_volume(part) - block_volume()
    assert abs(grew - RW * (H + OVER) * 15.352) < 1e-3, grew
    print(PASS, "join grows the two selected areas and stops at the block's bottom")


def test_cut_takes_only_the_selected_area():
    """The reported cut. Whole-profile resolution made this one remove every bit of
    the join above — the part 'vanishes completely'."""
    join = {"id": "f4", "type": "extrude", "sketch": "f3", "distance": 15.352,
            "operation": "join", "regions": [ONFACE, ABOVE], "hiddenBodies": []}
    cut = {"id": "f5", "type": "extrude", "sketch": "f3", "distance": 26.471,
           "operation": "cut", "regions": [ABOVE], "hiddenBodies": []}
    joined, errs = build(join)
    assert errs == [], errs
    part, errs = build(join, cut)
    assert errs == [], errs
    removed = _solid_volume(joined) - _solid_volume(part)
    assert abs(removed - RW * OVER * 15.352) < 1e-3, removed
    assert _solid_volume(part) > block_volume(), "the cut took the whole join with it"
    print(PASS, "cut removes the one selected area, not the whole join")


def test_a_cut_that_empties_a_body_says_so():
    """CONTROL that must fail: the guard has to fire on a real annihilation, not
    on every cut. A body that goes to nothing left no message at all before —
    it was simply gone at the next repaint."""
    whole = {"id": "f4", "type": "extrude", "sketch": "f1", "distance": H * 2,
             "operation": "cut", "regions": [[0, 0, 0]], "hiddenBodies": []}
    _, errs, _ = rebuild(
        {"parameters": {}, "paramDefs": {}, "version": 8, "features": [*BLOCK, whole]},
        diagnostics=[],
    )
    assert len(errs) == 1, errs
    assert "remove all of Body1" in errs[0]["message"], errs[0]
    print(PASS, "a cut that would empty a body is refused, by name")


def test_revolve_spins_the_selected_area_only():
    """Revolve read the selected profile and then stored only its SKETCH, so the
    builder spun everything drawn on that plane. Two disks side by side, one
    picked: the other must not appear."""
    sk = {"id": "f3", "type": "sketch", "plane": "XZ", "entities": [
        {"type": "circle", "id": "c1", "radius": 2, "x": 10, "y": 60},
        {"type": "circle", "id": "c2", "radius": 2, "x": 20, "y": 60},
    ]}
    base = {"parameters": {}, "paramDefs": {}, "version": 8, "features": [*BLOCK, sk]}
    one = {"id": "f4", "type": "revolve", "sketch": "f3", "axis": "Z", "angle": 360,
           "operation": "new", "regions": [[10, 0, 60]]}
    _, errs, bodies = rebuild({**base, "features": [*base["features"], one]}, diagnostics=[])
    assert errs == [], errs
    bb = bodies[-1]["shape"].bounding_box()   # the revolve made its own New Body
    assert abs(bb.max.X - 12) < 1e-6, f"the unselected disk was spun too (x {bb.max.X})"
    # CONTROL that must fail if regions were ignored: no selection still spins both.
    both = {**one, "regions": []}
    _, errs, bodies = rebuild({**base, "features": [*base["features"], both]}, diagnostics=[])
    assert errs == [], errs
    assert abs(bodies[-1]["shape"].bounding_box().max.X - 22) < 1e-6
    print(PASS, "revolve spins the selected area, and the whole sketch without one")


# --- the plane test the split is built on -------------------------------------

def test_only_edges_that_lie_in_the_plane_count():
    """Every sample, not the ends: an edge CROSSING the plane has both ends off it
    and passes any single-point test at the crossing. Admitting one would cut the
    profile along a line that bounds nothing."""
    part, _ = build()
    o, n = FRONT.origin, FRONT.z_dir
    tol = plane_tolerance(_diag(part))
    inplane = edges_in_plane([part], o, n, tol)
    assert len(inplane) == 4, len(inplane)          # the front face's four edges
    for e in inplane:
        assert edge_lies_in_plane(e, o, n, tol)
    crossing = [e for e in part.edges() if e not in inplane]
    on = [e for e in crossing if edge_lies_in_plane(e, o, n, tol)]
    assert on == [], f"{len(on)} edges off the plane were counted as on it"
    print(PASS, "only the four edges actually in the plane are the outline")


def test_the_bbox_prefilter_never_rejects_an_edge_that_is_on_the_plane():
    """It is a REJECTION test — the box contains the edge, so a box wholly to one
    side holds nothing that reaches the plane. The converse does not hold, which
    is why it may only prune."""
    part, _ = build()
    o, n = FRONT.origin, FRONT.z_dir
    tol = plane_tolerance(_diag(part))
    pruned = 0
    for e in part.edges():
        keep = bbox_straddles_plane(e.bounding_box(), o, n, tol)
        if not keep:
            pruned += 1
            assert not edge_lies_in_plane(e, o, n, tol), "pruned an edge that is on the plane"
    assert pruned > 0, "the prefilter pruned nothing; it proves nothing here"
    print(PASS, f"the bbox prefilter drops {pruned} edges and no on-plane one")


def test_a_tool_that_misses_the_profile_leaves_it_whole():
    """CONTROL that must fail: the split has to be the model's outline doing the
    cutting, not the act of running a splitter. A tool edge to one side must come
    back with the profile intact and its area unchanged."""
    face = Face.make_rect(10, 10)
    assert len(split_faces([face], [])) == 1, "an empty tool list split the face"
    miss = Edge.make_line((20, -10, 0), (20, 10, 0))
    out = split_faces([face], [miss])
    assert len(out) == 1 and abs(out[0].area - 100) < 1e-9, [f.area for f in out]
    hit = Edge.make_line((0, -10, 0), (0, 10, 0))
    out = split_faces([face], [hit])
    assert len(out) == 2, [f.area for f in out]
    assert abs(sum(f.area for f in out) - 100) < 1e-9, [f.area for f in out]
    print(PASS, "a tool that misses leaves the profile whole; one that crosses halves it")


# --- helpers ------------------------------------------------------------------

class _Ctx:
    """Just enough of _RebuildCtx for _region_cells: the bodies to split against."""

    def __init__(self, part):
        self.bodies = [{"id": "body1", "name": "Body1", "shape": part}]


def _entry(sketch=SKETCH):
    from builder import _build_sketch

    return _build_sketch(sketch, lambda v: v, {})


def _diag(shape):
    bb = shape.bounding_box()
    return (bb.max - bb.min).length


if __name__ == "__main__":
    test_the_outline_cuts_the_profile_into_three()
    test_a_point_picks_its_own_area_not_the_profile()
    test_a_sketch_with_no_model_behind_it_is_left_whole()
    test_join_grows_only_the_selected_areas()
    test_cut_takes_only_the_selected_area()
    test_a_cut_that_empties_a_body_says_so()
    test_revolve_spins_the_selected_area_only()
    test_only_edges_that_lie_in_the_plane_count()
    test_the_bbox_prefilter_never_rejects_an_edge_that_is_on_the_plane()
    test_a_tool_that_misses_the_profile_leaves_it_whole()
    print("ALL PASS")
