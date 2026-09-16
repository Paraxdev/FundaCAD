"""Maximum cell size: the export edge-length cap stays closed, crack free and area preserving.

Run: uv run python test_mesh_refine.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import numpy as np

from mesh_refine import cap_edge_length


def _edges(pos, idx):
    p = np.asarray(pos).reshape(-1, 3)
    t = np.asarray(idx).reshape(-1, 3)
    out = []
    for a, b, c in t:
        for u, v in ((a, b), (b, c), (c, a)):
            out.append(np.linalg.norm(p[u] - p[v]))
    return out


def _edge_use(idx):
    t = np.asarray(idx).reshape(-1, 3)
    use = {}
    for a, b, c in t:
        for u, v in ((a, b), (b, c), (c, a)):
            k = (min(u, v), max(u, v))
            use[k] = use.get(k, 0) + 1
    return use


def _area(pos, idx):
    p = np.asarray(pos).reshape(-1, 3)
    t = np.asarray(idx).reshape(-1, 3)
    return 0.5 * np.linalg.norm(np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]]), axis=1).sum()


# A closed tetrahedron with 10 mm edges: every edge is shared by exactly two triangles.
TET_POS = [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]
TET_IDX = [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]


def test_no_cap_leaves_the_mesh_alone():
    pos, idx = cap_edge_length(TET_POS, TET_IDX, 0, 10_000)
    assert len(idx) == len(TET_IDX)


def test_every_edge_ends_up_under_the_cap():
    pos, idx = cap_edge_length(TET_POS, TET_IDX, 3.0, 1_000_000)
    assert max(_edges(pos, idx)) <= 3.0 + 1e-9


def test_stays_closed_with_no_cracks():
    pos, idx = cap_edge_length(TET_POS, TET_IDX, 4.0, 1_000_000)
    assert set(_edge_use(idx).values()) == {2}


def test_keeps_the_surface_area():
    pos, idx = cap_edge_length(TET_POS, TET_IDX, 2.5, 1_000_000)
    assert abs(_area(pos, idx) - _area(TET_POS, TET_IDX)) < 1e-6


def test_mixed_splits_stay_conforming():
    # A long thin triangle pair: only some edges exceed the cap, which exercises the 1 and 2 split cases.
    pos = [0, 0, 0, 20, 0, 0, 20, 1, 0, 0, 1, 0]
    idx = [0, 1, 2, 0, 2, 3]
    out_pos, out_idx = cap_edge_length(pos, idx, 6.0, 1_000_000)
    assert max(_edges(out_pos, out_idx)) <= 6.0 + 1e-9
    use = _edge_use(out_idx)
    # Interior edges are shared twice, the boundary once; a crack would show as a 1 inside.
    boundary = [k for k, n in use.items() if n == 1]
    assert abs(_area(out_pos, out_idx) - 20.0) < 1e-6
    p = np.asarray(out_pos).reshape(-1, 3)
    perimeter = sum(np.linalg.norm(p[a] - p[b]) for a, b in boundary)
    assert abs(perimeter - 42.0) < 1e-6


def test_stops_at_the_triangle_budget():
    pos, idx = cap_edge_length(TET_POS, TET_IDX, 0.01, 500)
    assert len(idx) // 3 <= 500 * 4


if __name__ == "__main__":
    print("mesh refine")
    test_no_cap_leaves_the_mesh_alone()
    test_every_edge_ends_up_under_the_cap()
    test_stays_closed_with_no_cracks()
    test_keeps_the_surface_area()
    test_mixed_splits_stay_conforming()
    test_stops_at_the_triangle_budget()
    print("all mesh refine tests passed")
