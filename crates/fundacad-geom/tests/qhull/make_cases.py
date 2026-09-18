"""Write cases.json: point sets and the triangles scipy.spatial.Delaunay makes of
them, for tests/qhull_parity.rs to hold the kernel's delaunay-planar against.

Besides random and gridded sets (co-circular ties everywhere), it records the
triangulations the texture plugin's Python half asks for on a few documents, so
the parity is checked on the inputs that matter.

Run from sidecar/ with the sidecar venv:
  python ../crates/fundacad-geom/tests/qhull/make_cases.py
"""

import json
import math
import os
import sys

import numpy as np
import scipy.spatial

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
sys.path.insert(0, os.path.join(REPO, "sidecar"))
sys.path.insert(0, os.path.join(REPO, "plugins", "FundaCAD.Texture", "geometry"))

cases = []
DELAUNAY = scipy.spatial.Delaunay


def record(name, pts):
    pts = np.ascontiguousarray(pts, dtype=np.float64)
    tri = DELAUNAY(pts)
    cases.append({"name": name, "points": pts.ravel().tolist(), "simplices": tri.simplices.ravel().tolist()})


def synthetic():
    rng = np.random.default_rng(7)
    record("random_200", rng.uniform(-10, 10, (200, 2)))
    g = np.stack(np.meshgrid(np.arange(8.0), np.arange(6.0), indexing="ij"), -1).reshape(-1, 2)
    record("unit_grid", g)
    a = math.radians(45)
    rot = g @ np.array([[math.cos(a), math.sin(a)], [-math.sin(a), math.cos(a)]])
    record("rotated_grid", rot)
    ring = np.array([[math.cos(t), math.sin(t)] for t in np.linspace(0, 2 * math.pi, 24, endpoint=False)])
    record("circle_and_centre", np.vstack([ring * 5.0, [[0.0, 0.0]]]))
    record("collinear_hull", np.vstack([np.stack([np.linspace(0, 4, 9), np.zeros(9)], 1), [[2.0, 3.0], [1.0, 1.0]]]))


def from_texture(max_calls=1):
    import plugin_geometry
    import texture
    from builder import rebuild
    from tessellate import tessellate

    plugin_geometry.discover()
    real = scipy.spatial.Delaunay
    seen = {"n": 0}

    def spy(pts, *a, **k):
        if seen["n"] < max_calls:
            record(f"texture_{seen['tag']}_{seen['n']}", pts)
        seen["n"] += 1
        return real(pts, *a, **k)

    scipy.spatial.Delaunay = spy
    try:
        docs = {
            "knurl45": [{"id": "b", "type": "box", "length": 30, "width": 30, "height": 10},
                        {"id": "t", "type": "texture", "kind": "knurl", "depth": 0.4, "scale": 2.0, "angle": 45,
                         "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}}],
            "hexcyl": [{"id": "c", "type": "cylinder", "radius": 10, "height": 20},
                       {"id": "t", "type": "texture", "kind": "hex", "depth": 0.4, "scale": 2.0,
                        "faces": {"kind": "face", "by": "nearest", "point": [10, 0, 0]}}],
            "roundknurl": [{"id": "b", "type": "box", "length": 20, "width": 20, "height": 10},
                           {"id": "t", "type": "texture", "kind": "knurl", "depth": 0.3, "scale": 2.0,
                            "profile": "round", "faces": {"kind": "face", "by": "normal", "dir": [0, 0, 1]}}],
        }
        for tag, feats in docs.items():
            seen["tag"], seen["n"] = tag, 0
            _p, errs, bodies = rebuild({"parameters": {}, "features": feats})
            assert not errs, errs
            resolved = plugin_geometry.resolve(bodies[0])
            texture._GEOM_CACHE.clear()
            tessellate(bodies[0]["shape"], 0.1, mesh_passes=resolved, density_cap=80_000)
    finally:
        scipy.spatial.Delaunay = real


def main():
    synthetic()
    from_texture()
    with open(os.path.join(HERE, "cases.json"), "w", encoding="utf-8", newline="\n") as fh:
        json.dump({"cases": cases}, fh)
    print(len(cases), "cases")


if __name__ == "__main__":
    main()
