"""Which faces of a shape touch which — the one rule four callers now share.

The property everything here turns on is that "adjacent" means SHARING AN EDGE
in the kernel's sense: the same TShape, not two edges that happen to lie on top
of one another. Two bodies pressed face to face have coincident geometry and no
shared topology, and `_refacet_clean` depends on being able to tell them apart —
if it could not, it would sew two touching imported parts into one. So the
controls below matter more than the positive cases: a box's OPPOSITE walls must
not be neighbours, and two touching boxes must stay two components.

Run: uv run python tests/test_topo_adj.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

from build123d import Box, Compound, Pos

from topo_adj import FaceAdjacency


def test_a_box_has_six_faces_each_touching_four():
    adj = FaceAdjacency(Box(20, 20, 10))
    assert adj.extent == 6, adj.extent
    assert list(adj.indices()) == [1, 2, 3, 4, 5, 6]
    for i in adj.indices():
        n = adj.neighbors(i)
        assert len(n) == 4, f"face {i} has {len(n)} neighbours, expected 4"
        assert i not in n, "a face is not its own neighbour"


def test_opposite_walls_are_not_neighbours():
    """The control for the positive case above. Opposite walls of a box are
    parallel, the same size, and the only pair a face does NOT touch; a rule
    that counted coincident geometry rather than shared edges would join them."""
    adj = FaceAdjacency(Box(20, 20, 10))
    # every face has exactly one non-neighbour besides itself: its opposite
    for i in adj.indices():
        others = set(adj.indices()) - {i} - adj.neighbors(i)
        assert len(others) == 1, f"face {i} has {len(others)} non-neighbours"
        j = others.pop()
        ni, nj = adj.face(i).normal_at(), adj.face(j).normal_at()
        assert ni.dot(nj) < -0.99, "the non-neighbour should be the opposite wall"


def test_adjacency_is_symmetric():
    adj = FaceAdjacency(Box(8, 12, 30))
    for i in adj.indices():
        for j in adj.neighbors(i):
            assert i in adj.neighbors(j), f"{i}->{j} but not {j}->{i}"


def test_walk_hands_back_the_edge_that_is_shared():
    """`walk` yields the edge as well as the face, which is what the blend-chain
    expansion needs: it measures the dihedral angle AT a point on that edge."""
    adj = FaceAdjacency(Box(20, 20, 10))
    from build123d import Edge
    from OCP.TopoDS import TopoDS

    seen = 0
    for i in adj.indices():
        for j, e in adj.walk(i):
            length = Edge(TopoDS.Edge_s(e)).length
            assert length in (10.0, 20.0), f"unexpected shared edge length {length}"
            # the shared edge belongs to BOTH faces
            assert any(x.is_same(Edge(TopoDS.Edge_s(e))) for x in adj.face(j).edges())
            seen += 1
    assert seen == 24, f"a box has 12 edges, each seen from both sides: {seen}"


def test_one_body_is_one_component():
    adj = FaceAdjacency(Box(20, 20, 10))
    comps = adj.components()
    assert len(comps) == 1 and len(comps[0]) == 6, comps


def test_two_bodies_apart_are_two_components():
    part = Compound([Box(10, 10, 10), Pos(50, 0, 0) * Box(10, 10, 10)])
    comps = FaceAdjacency(part).components()
    assert len(comps) == 2, f"expected 2 components, got {len(comps)}"
    assert sorted(len(c) for c in comps) == [6, 6], comps


def test_two_bodies_TOUCHING_are_still_two_components():
    """The control that _refacet_clean's correctness rests on. These two boxes
    share a plane exactly — one spans -5 to 5 in X, the other 5 to 15 — so their
    facing walls are coincident to the last bit. They are still two bodies, because coincident is
    not shared, and a component split that used geometry would fuse them."""
    part = Compound([Box(10, 10, 10), Pos(10, 0, 0) * Box(10, 10, 10)])
    comps = FaceAdjacency(part).components()
    assert len(comps) == 2, f"touching bodies fused into {len(comps)} component(s)"
    assert sorted(len(c) for c in comps) == [6, 6], comps


def test_two_bodies_FUSED_are_one_component():
    """The other half of the control above: components() does join when the
    topology says so, so "2" for the touching pair is a finding, not a habit."""
    part = Box(10, 10, 10) + Pos(10, 0, 0) * Box(10, 10, 10)
    comps = FaceAdjacency(part).components()
    assert len(comps) == 1, f"a fused pair should be 1 component, got {len(comps)}"


def test_a_face_from_another_shape_has_no_index():
    """index_of answers 0 rather than raising or picking a lookalike, which is
    what lets _wound_boundary skip faces that are not part of its shape."""
    adj = FaceAdjacency(Box(20, 20, 10))
    stranger = Box(20, 20, 10).faces()[0]  # same size, same place, other TShape
    assert adj.index_of(stranger) == 0
    assert adj.index_of(adj.face(1)) == 1


def test_index_and_key_agree():
    adj = FaceAdjacency(Box(3, 4, 5))
    for i in adj.indices():
        assert adj.index_of(adj.key(i)) == i
        assert adj.face(i) is adj.face(i), "the wrapped Face is cached, not rebuilt"


def main():
    failed = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
        except Exception:
            traceback.print_exc()
            print(f"FAIL {name}")
            failed += 1
    print("topo adjacency:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
