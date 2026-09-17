"""Cap a triangle mesh's edge length for export ("maximum cell size").

OCCT's mesher bounds deviation, not size, so a large flat face comes out as a
few long slivers. Splitting every edge longer than the cap at its midpoint, and
re-triangulating each triangle by how many of its edges were split, keeps the
mesh conforming: both triangles on an edge see the same split and share the
new vertex, so no cracks open in the mesh.
"""

import numpy as np

# Each pass at least halves every long edge, so this reaches a 1000x ratio.
MAX_PASSES = 10


def cap_edge_length(positions, indices, max_edge, triangle_budget):
    """Return (positions, indices) with no edge longer than `max_edge`, stopping
    early rather than exceeding `triangle_budget` triangles."""
    pos = np.asarray(positions, dtype=np.float64).reshape(-1, 3)
    tri = np.asarray(indices, dtype=np.int64).reshape(-1, 3)
    if max_edge is None or max_edge <= 0 or len(tri) == 0:
        return pos.reshape(-1), tri.reshape(-1)
    limit2 = float(max_edge) ** 2
    for _ in range(MAX_PASSES):
        a, b, c = tri[:, 0], tri[:, 1], tri[:, 2]
        long_ab = ((pos[a] - pos[b]) ** 2).sum(1) > limit2
        long_bc = ((pos[b] - pos[c]) ** 2).sum(1) > limit2
        long_ca = ((pos[c] - pos[a]) ** 2).sum(1) > limit2
        marks = np.stack([long_ab, long_bc, long_ca], axis=1)
        if not marks.any():
            break
        # Marked on either side of an edge means split on both, the conforming rule.
        edges = np.concatenate([
            np.stack([a, b], 1)[long_ab], np.stack([b, c], 1)[long_bc], np.stack([c, a], 1)[long_ca],
        ])
        edges = np.unique(np.sort(edges, axis=1), axis=0)
        new_pos = (pos[edges[:, 0]] + pos[edges[:, 1]]) * 0.5
        mid = {(int(u), int(v)): len(pos) + i for i, (u, v) in enumerate(edges)}
        pos = np.concatenate([pos, new_pos])

        def m(u, v):
            return mid.get((u, v) if u < v else (v, u))

        out = []
        grow = 0
        for t in range(len(tri)):
            p, q, r = (int(x) for x in tri[t])
            mpq, mqr, mrp = m(p, q), m(q, r), m(r, p)
            n = (mpq is not None) + (mqr is not None) + (mrp is not None)
            if n == 0:
                out.append((p, q, r))
            elif n == 3:
                out += [(p, mpq, mrp), (mpq, q, mqr), (mrp, mqr, r), (mpq, mqr, mrp)]
            elif n == 1:
                # Rotate so the split edge is p-q.
                if mqr is not None:
                    p, q, r = q, r, p
                elif mrp is not None:
                    p, q, r = r, p, q
                mm = m(p, q)
                out += [(p, mm, r), (mm, q, r)]
            else:
                # Rotate so the unsplit edge is r-p.
                if mpq is None:
                    p, q, r = q, r, p
                elif mqr is None:
                    p, q, r = r, p, q
                m1, m2 = m(p, q), m(q, r)
                out += [(p, m1, m2), (m1, q, m2), (p, m2, r)]
            grow = len(out)
        if grow > triangle_budget:
            break
        tri = np.asarray(out, dtype=np.int64)
    return pos.reshape(-1), tri.reshape(-1)
