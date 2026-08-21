"""A pick cannot be ambiguous between an edge and its own twin.

Two prisms that meet along a single corner line fuse into one body that carries
that line TWICE: the fuse has no face to merge, so each prism keeps its own copy.
Both copies sit at the same point, run the same length and score the same
distance from any pick, so `by:"nearest"` measured a perfect tie and refused —
"re-pick the edge, the saved reference no longer identifies one", of an edge that
no pick can identify differently. On the reported document that killed every
blend on the body.

Also here: a FACE selector handed to an edge field. Fillet-a-face and the
ambiguous-reference repair both produce one, and it used to fall through to the
by:"nearest" edge branch, which read the face's pick point as an edge point and
returned whichever edge happened to be closest to it.

Run: uv run python tests/test_coincident_edges.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

from build123d import Box, Compound, Pos

from builder import _as_compound, _serial_bool
from geom_select import _edge_dedup_key, resolve_edges, resolve_faces

PASS = "  ok"

# The reported shape, from primitives: a plate, and two 10x10x9 prisms that meet
# along exactly one vertical line (x=0, y=0) and nothing else. Joined the way the
# document made them — ONE extrude of a two-region sketch, so the tool is a
# compound of both prisms and the fuse is _serial_bool. The result is a single
# valid solid, and the seam line is in it twice: the fuse has no face to merge at
# a contact of measure zero, so each prism keeps its own copy.
PLATE = Pos(0, 0, -2.5) * Box(60, 60, 5)
A = Pos(-5, 5, 4.5) * Box(10, 10, 9)
B = Pos(5, -5, 4.5) * Box(10, 10, 9)
TOUCHING = _serial_bool(_as_compound(PLATE), _as_compound(Compound([A, B])), "fuse")

# The control: one prism, whose corner edges are each unique.
LONE = Pos(-5, 5, 4.5) * Box(10, 10, 9)


def test_the_seam_edge_really_is_there_twice():
    """Without this the rest of the file could pass on a body that never had the
    problem — the fuse might have merged the seam on some OCCT version."""
    keys = {}
    for e in TOUCHING.edges():
        keys.setdefault(_edge_dedup_key(e), 0)
        keys[_edge_dedup_key(e)] += 1
    dup = [k for k, n in keys.items() if n > 1]
    assert len(TOUCHING.solids()) == 1, "the join did not produce one solid"
    assert dup, "the two prisms did not leave a duplicated seam edge"
    assert len(dup) == 1, f"expected one duplicated edge, got {dup}"
    assert abs(dup[0][0]) < 1e-9 and abs(dup[0][1]) < 1e-9, dup
    print(PASS, f"the corner seam is present twice at {dup[0][:3]}")
    # ...and the lone prism has none, so a duplicate is a property of the JOIN.
    lone = {}
    for e in LONE.edges():
        lone[_edge_dedup_key(e)] = lone.get(_edge_dedup_key(e), 0) + 1
    assert not [k for k, n in lone.items() if n > 1]
    print(PASS, "one prism on its own has no duplicated edge (control)")


def test_a_pick_on_the_seam_resolves_instead_of_refusing():
    sel = {"kind": "edge", "by": "nearest", "point": [0.0, 0.0, 4.5]}
    edges = resolve_edges(TOUCHING, sel)
    assert len(edges) == 1, edges
    c = edges[0].center()
    assert abs(c.X) < 1e-6 and abs(c.Y) < 1e-6, (c.X, c.Y, c.Z)
    print(PASS, "the seam edge resolves to one edge, not to a refusal")


def test_a_genuine_tie_still_refuses():
    """The control that must fail. Deduping indistinguishable candidates must not
    quietly turn a real ambiguity — two DIFFERENT edges equally close — into a
    guess, which is the fault the tie gate exists for."""
    # The prism's own centre: every one of its twelve edges is the same distance
    # away, and they are twelve different edges.
    sel = {"kind": "edge", "by": "nearest", "point": [-5.0, 5.0, 4.5]}
    try:
        resolve_edges(LONE, sel)
    except ValueError as ex:
        assert "ambiguous edge reference" in str(ex), str(ex)
        print(PASS, "two genuinely different edges equally close still refuse")
        return
    raise AssertionError("an ambiguous pick between two different edges did not refuse")


def test_a_face_selector_means_the_edges_around_that_face():
    # The top face of the lone prism: four edges, and the pick point is the face
    # CENTRE, which is nowhere near any of them.
    sel = {"kind": "face", "by": "nearest", "point": [-5.0, 5.0, 9.0]}
    edges = resolve_edges(LONE, sel)
    assert len(edges) == 4, [e.center() for e in edges]
    assert all(abs(e.center().Z - 9.0) < 1e-6 for e in edges), "not the top face's edges"
    assert all(abs(e.length - 10.0) < 1e-6 for e in edges)
    # and it is the same face resolve_faces finds, not a coincidence
    (face,) = resolve_faces(LONE, sel)
    assert abs(face.area - 100.0) < 1e-6, face.area
    print(PASS, "a face selector gives the 4 edges around the face")


def test_a_face_selector_does_not_fall_through_to_a_nearest_edge():
    """The reported failure, in one line: a face pick point read as an edge point
    picked an edge 2.14mm away that nobody had selected. A face selector must
    never resolve to a single edge."""
    sel = {"kind": "face", "by": "nearest", "point": [-5.0, 5.0, 9.0]}
    assert len(resolve_edges(LONE, sel)) > 1
    print(PASS, "a face selector never collapses to one nearest edge")


if __name__ == "__main__":
    test_the_seam_edge_really_is_there_twice()
    test_a_pick_on_the_seam_resolves_instead_of_refusing()
    test_a_genuine_tie_still_refuses()
    test_a_face_selector_means_the_edges_around_that_face()
    test_a_face_selector_does_not_fall_through_to_a_nearest_edge()
    print("ALL PASS")
