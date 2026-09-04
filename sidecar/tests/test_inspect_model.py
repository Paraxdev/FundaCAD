"""What the model measures, and — the part that matters more — what a caller can
then DO with the answer.

Two properties are worth more here than any single number:

  * the selectors are round-trippable. Every face and edge comes back with a
    `by:"match"` selector, and feeding that selector straight back to
    geom_select must return the SAME face or edge. A report of geometry nobody
    can address again is a report nobody can act on, and the failure would be
    invisible in the numbers.

  * the seam flag is real. A cylinder's side is one face that closes on itself,
    and the edge where it closes lists that face twice. The control is the box:
    a shape with no closed face must produce no seam at all, or the flag would
    just be noise on every model.

Run: uv run python tests/test_inspect_model.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import math
import sys
import traceback

from build123d import Box, Cylinder, Pos

from geom_select import resolve_edges, resolve_faces
from inspect_model import inspect_bodies


def _bodies(*shapes):
    return [{"id": f"b{i + 1}", "name": f"Body{i + 1}", "shape": s}
            for i, s in enumerate(shapes)]


def one(shape, **kw):
    return inspect_bodies(_bodies(shape), **kw)[0]


# --- the measurements ---------------------------------------------------------


def test_a_box_measures_what_a_box_measures():
    b = one(Box(20, 10, 4))
    assert abs(b["volume"] - 800.0) < 1e-6, b["volume"]
    assert abs(b["area"] - 2 * (200 + 80 + 40)) < 1e-6, b["area"]
    assert b["faceCount"] == 6 and b["edgeCount"] == 12, b
    assert b["solidCount"] == 1
    assert [round(v) for v in b["centerOfMass"]] == [0, 0, 0], b["centerOfMass"]
    assert b["bbox"]["size"] == [20.0, 10.0, 4.0], b["bbox"]


def test_a_cylinder_measures_pi_r_squared_h():
    b = one(Cylinder(radius=10, height=20))
    assert abs(b["volume"] - math.pi * 100 * 20) < 1e-4, b["volume"]
    side = [f for f in b["faces"] if f["surface"] == "cylinder"]
    assert len(side) == 1, [f["surface"] for f in b["faces"]]
    assert abs(side[0]["radius"] - 10.0) < 1e-9
    assert side[0]["axis"] == [0.0, 0.0, 1.0], side[0]["axis"]


def test_two_bodies_are_reported_separately():
    rep = inspect_bodies(_bodies(Box(10, 10, 10), Pos(40, 0, 0) * Box(2, 2, 2)))
    assert [b["id"] for b in rep] == ["b1", "b2"]
    assert abs(rep[0]["volume"] - 1000.0) < 1e-6
    assert abs(rep[1]["volume"] - 8.0) < 1e-6


def test_a_body_that_did_not_build_says_so_instead_of_vanishing():
    rep = inspect_bodies([{"id": "b1", "name": "Body1", "shape": None}])
    assert rep == [{"id": "b1", "name": "Body1", "empty": True}], rep


# --- the point on each face ---------------------------------------------------


def test_every_face_point_lies_on_that_face():
    """`point` is the centroid PROJECTED onto the surface, and the projection is
    the whole reason the field exists: a cylinder's centroid is on its axis,
    10mm from the surface it is supposed to name."""
    shape = Cylinder(radius=10, height=20)
    b = one(shape)
    faces = list(shape.faces())
    for f in b["faces"]:
        p = f.get("point")
        assert p is not None, f"face {f['i']} has no point"
        d = faces[f["i"]].distance_to(tuple(p))
        assert d < 1e-6, f"face {f['i']} point is {d} from the face"


def test_the_centroid_of_a_washer_face_is_in_the_HOLE():
    """The control for the test above, and the reason the projection is there at
    all. A washer's flat face has its centroid on the axis, which is a point in
    mid-air; handing that back as "a point on this face" would send every
    by:"nearest" pick to whatever is nearest the hole."""
    washer = Cylinder(radius=10, height=4) - Cylinder(radius=5, height=4)
    b = one(washer)
    flats = [f for f in b["faces"] if f["surface"] == "plane"]
    assert len(flats) == 2, [f["surface"] for f in b["faces"]]
    faces = list(washer.faces())
    for f in flats:
        assert f["centroid"] != f["point"], f
        # the centroid is off the face by the inner radius; the point is on it
        assert faces[f["i"]].distance_to(tuple(f["centroid"])) > 4.9, f
        assert faces[f["i"]].distance_to(tuple(f["point"])) < 1e-6, f


# --- the selectors ------------------------------------------------------------


def test_every_face_selector_finds_its_own_face_again():
    shape = Cylinder(radius=10, height=20)
    b = one(shape)
    faces = list(shape.faces())
    for f in b["faces"]:
        got = resolve_faces(shape, f["selector"])
        assert len(got) == 1, f"face {f['i']} selector resolved to {len(got)}"
        assert abs(got[0].area - faces[f["i"]].area) < 1e-6, f["i"]
        assert math.dist(_c(got[0]), _c(faces[f["i"]])) < 1e-6, f["i"]


def test_every_edge_selector_finds_its_own_edge_again():
    shape = Box(20, 10, 4)
    b = one(shape)
    edges = list(shape.edges())
    for e in b["edges"]:
        got = resolve_edges(shape, e["selector"])
        assert len(got) == 1, f"edge {e['i']} selector resolved to {len(got)}"
        assert abs(got[0].length - edges[e["i"]].length) < 1e-6, e["i"]
        assert math.dist(_c(got[0]), _c(edges[e["i"]])) < 1e-6, e["i"]


def _c(x):
    c = x.center()
    return (c.X, c.Y, c.Z)


# --- seams and adjacency ------------------------------------------------------


def test_a_cylinder_has_exactly_one_seam():
    b = one(Cylinder(radius=10, height=20))
    seams = [e for e in b["edges"] if e.get("seam")]
    assert len(seams) == 1, [(e["i"], e["curve"], e["faces"]) for e in b["edges"]]
    assert seams[0]["curve"] == "line", seams[0]
    assert seams[0]["faces"][0] == seams[0]["faces"][1]
    side = [f for f in b["faces"] if f["surface"] == "cylinder"][0]
    assert seams[0]["faces"][0] == side["i"], (seams[0], side["i"])


def test_a_box_has_no_seam_at_all():
    """The control. Nothing on a box closes on itself, so a seam flag that fired
    here would mean the test above proves nothing."""
    b = one(Box(20, 10, 4))
    assert not any(e.get("seam") for e in b["edges"])
    assert not any(f["wraps"] for f in b["faces"])
    assert not any(e.get("openBoundary") for e in b["edges"])


def test_only_the_side_of_a_cylinder_wraps():
    b = one(Cylinder(radius=10, height=20))
    wrapping = [f["surface"] for f in b["faces"] if f["wraps"]]
    assert wrapping == ["cylinder"], [(f["surface"], f["wraps"]) for f in b["faces"]]


def test_each_edge_names_the_two_faces_it_lies_between():
    shape = Box(20, 10, 4)
    b = one(shape)
    for e in b["edges"]:
        assert len(e["faces"]) == 2, e
        assert e["faces"][0] != e["faces"][1], e
        for j in e["faces"]:
            assert 0 <= j < b["faceCount"], e


def test_neighbours_are_symmetric_and_match_the_shared_edges():
    """Face adjacency reported here has to agree with the edges reported here —
    they come from the same map, and a numbering slip between comp.faces() and
    the OCCT shape map would show up as exactly this disagreement."""
    b = one(Box(20, 10, 4))
    by_i = {f["i"]: set(f["neighbors"]) for f in b["faces"]}
    for i, ns in by_i.items():
        assert i not in ns
        for j in ns:
            assert i in by_i[j], f"{i} lists {j} but not the other way round"
    from_edges = set()
    for e in b["edges"]:
        a, c = e["faces"]
        from_edges.add((min(a, c), max(a, c)))
    from_faces = {(min(i, j), max(i, j)) for i, ns in by_i.items() for j in ns}
    assert from_edges == from_faces, (from_edges ^ from_faces)


# --- caps ---------------------------------------------------------------------


def test_detail_can_be_left_out_entirely():
    b = one(Box(20, 10, 4), detail=False)
    assert "faces" not in b and "edges" not in b
    assert b["faceCount"] == 6 and b["volume"] == 800.0


def test_a_cap_truncates_and_says_by_how_much():
    b = one(Box(20, 10, 4), max_faces=2, max_edges=3)
    assert len(b["faces"]) == 2 and len(b["edges"]) == 3
    assert b["truncated"] == {"faces": 4, "edges": 9}, b["truncated"]
    assert b["faceCount"] == 6 and b["edgeCount"] == 12


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
    print("inspect model:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
