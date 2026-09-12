"""The display mesh carries true surface normals and no seam shading line.

The report: a lofted dome looked rippled across its crown and had a faint
vertical line down one flank, in the app only. Both were the client shading from
the mesh alone. It averaged each vertex's facet normals, which on a freeform face
is only as smooth as the viewport mesh is fine, and a closed curved face is meshed
with its seam nodes duplicated, so each copy was averaged over its own side of the
seam and a shading step ran down it (7.3 degrees on the dome).

The display tessellation now ships the surface's own normal at every node and
merges the seam copies. What is pinned here:
  * normals tile EVERY vertex of the display mesh, not only displaced faces
    (the old payload sent none for a plain face, which is the control: the tiling
    assertion fails on it);
  * they are unit length and agree with the triangle winding, on a moved and
    rotated body too, and on faces the kernel marks REVERSED, whose computed
    normals come back pointing inward before correction;
  * coincident vertices inside one face no longer disagree by a shading step;
  * the EXPORT mesh is untouched: same triangles, seam copies still present, no
    normals.

Run: uv run python tests/test_display_normals.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback
from collections import defaultdict

import numpy as np
from build123d import Box, Cone, Cylinder, Ellipse, Plane, Pos, Rot, Sphere, Torus, fillet, loft

from tessellate import tessellate

TOL, ANG = 0.002, 0.18  # the shipping viewport profile (server._VIEWPORT_*)


def _loft_dome():
    """A dome lofted through closed elliptical rings: one closed freeform face,
    exactly the kind of surface the report was about."""
    rings = []
    for z, rx, ry in ((0, 40, 20), (10, 38, 19), (20, 30, 15), (26, 16, 8), (28, 3, 1.5)):
        rings.append(Plane.XY.offset(z) * Ellipse(rx, ry))
    return loft(rings)


def _shapes():
    return {
        "cylinder": Cylinder(10, 30),
        "sphere": Sphere(20),
        "cone": Cone(15, 0, 30),
        "torus": Torus(20, 5),
        "filleted box": fillet(Box(40, 40, 20).edges(), 4),
        "moved, rotated cylinder": Pos(30, -12, 7) * Rot(35, 20, 60) * Cylinder(8, 25),
        "lofted dome": _loft_dome(),
    }


def _display(shape):
    chunks = []
    pos, idx, fids = tessellate(shape, TOL, angular_tolerance=ANG, relative=True,
                                force_remesh=True, normals_out=chunks)
    return pos, idx, fids, chunks


def _facet_vertex_normals(P, T):
    fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    acc = np.zeros_like(P)
    for k in range(3):
        np.add.at(acc, T[:, k], fn)
    return acc / (np.linalg.norm(acc, axis=1, keepdims=True) + 1e-12)


def test_normals_tile_every_vertex_of_the_display_mesh():
    for name, shape in _shapes().items():
        pos, _idx, _fids, chunks = _display(shape)
        covered = np.zeros(len(pos) // 3, dtype=int)
        for vbase, chunk in chunks:
            covered[vbase:vbase + len(chunk) // 3] += 1
        assert (covered == 1).all(), f"{name}: normals cover {np.count_nonzero(covered)} of {len(covered)} vertices"
    print("normals tile every display vertex OK")


def test_normals_are_unit_and_agree_with_the_winding():
    for name, shape in _shapes().items():
        pos, idx, _fids, chunks = _display(shape)
        P = np.asarray(pos).reshape(-1, 3)
        T = np.asarray(idx).reshape(-1, 3)
        N = np.zeros_like(P)
        for vbase, chunk in chunks:
            N[vbase:vbase + len(chunk) // 3] = np.asarray(chunk).reshape(-1, 3)
        lengths = np.linalg.norm(N, axis=1)
        assert np.allclose(lengths, 1.0, atol=1e-3), f"{name}: non-unit normals"
        dots = np.einsum("ij,ij->i", N, _facet_vertex_normals(P, T))
        # cos(25 deg): a coarse facet average may lean off the true normal by up to
        # the angular tolerance, an inward (reversed) normal reads as about -1
        assert dots.min() > 0.9, f"{name}: a normal disagrees with its winding (min dot {dots.min():.3f})"
    print("normals are unit length and follow the winding OK")


def test_no_shading_step_between_coincident_vertices_of_one_face():
    """Measured on what the client DRAWS: the shipped normal where there is one,
    otherwise the facet average the client computes itself, which is what used to
    step across a seam."""
    for name, shape in _shapes().items():
        pos, idx, fids, chunks = _display(shape)
        P = np.asarray(pos).reshape(-1, 3)
        T = np.asarray(idx).reshape(-1, 3)
        N = _facet_vertex_normals(P, T)
        for vbase, chunk in chunks:
            N[vbase:vbase + len(chunk) // 3] = np.asarray(chunk).reshape(-1, 3)
        face_of = np.full(len(P), -1)
        for t, f in enumerate(fids):
            face_of[T[t]] = f
        groups = defaultdict(list)
        for v, key in enumerate(map(tuple, np.round(P, 5))):
            groups[(key, int(face_of[v]))].append(v)
        steps = []
        for ids in groups.values():
            for a in ids[1:]:
                gap = np.degrees(np.arccos(np.clip(N[ids[0]] @ N[a], -1, 1)))
                if 0.5 < gap < 30:  # a degenerate apex may keep genuinely different copies
                    steps.append(gap)
        assert not steps, f"{name}: {len(steps)} seam copies shade apart, worst {max(steps):.1f} deg"
    print("no shading step along a seam OK")


def test_the_export_mesh_is_unchanged():
    """Export never passes normals_out, so it gets the kernel's triangulation as it
    always did: the same triangle count as the display mesh, but the seam copies
    still separate (the weld is a display concern) and no normals."""
    shape = Cylinder(10, 30)
    ex_pos, ex_idx, ex_fids = tessellate(shape, TOL, angular_tolerance=ANG, relative=True, force_remesh=True)
    dpos, didx, dfids, _chunks = _display(shape)
    assert len(ex_idx) == len(didx) and ex_fids == dfids, "display and export triangles differ"
    assert len(ex_pos) > len(dpos), "export lost its seam copies, so the weld leaked out of the display path"
    print("export mesh unchanged OK")


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
    print("display normals:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
