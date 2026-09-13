"""A body that is another placement of an already meshed shape reuses its payload.

An imported assembly is mostly instances: one TShape at many Locations. The
payload loop now meshes the first and moves the result for the rest. What is
pinned here is that the moved payload is the payload a from-scratch build of that
instance produces: same triangles and face ids, same vertices, normals, edges and
box to rounding.

Run: .venv/Scripts/python.exe tests/test_instance_payload.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import sys
import traceback

import numpy as np
from build123d import Axis, Box, Cylinder, Location, fillet

import server

TOL = server._DEFAULT_TOLERANCE
PROFILE = server._viewport_profile(1)


def _part():
    s = Box(30, 20, 10) - Cylinder(4, 10)
    return fillet(s.edges().group_by(Axis.Z)[-1], 1.5)


def _body(bid, shape):
    return {"id": bid, "name": bid, "shape": shape}


def _compare(moved, fresh):
    for key in ("indices", "faceIds", "faceCount", "faceBands"):
        assert moved.get(key) == fresh.get(key), key
    np.testing.assert_allclose(moved["positions"], fresh["positions"], atol=1e-6)
    np.testing.assert_allclose(moved["normals"], fresh["normals"], atol=1e-6)
    assert len(moved["edges"]) == len(fresh["edges"])
    for a, b in zip(moved["edges"], fresh["edges"]):
        np.testing.assert_allclose(a["points"], b["points"], atol=1e-6)
    np.testing.assert_allclose(moved["bbox"]["min"], fresh["bbox"]["min"], atol=1e-6)
    np.testing.assert_allclose(moved["bbox"]["max"], fresh["bbox"]["max"], atol=1e-6)


def test_a_moved_instance_matches_a_fresh_build():
    base = _part()
    placed = base.moved(Location((120, -40, 15), (0.3, 0.8, 0.2), 37))

    server._MESH_CACHE.clear()
    server._INSTANCE_PAYLOADS.clear()
    server._body_payload(_body("a", base), TOL, PROFILE)
    assert len(server._INSTANCE_PAYLOADS) == 1, "the first instance was not remembered"
    moved = server._body_payload(_body("b", placed), TOL, PROFILE)["payload"]
    assert len(server._INSTANCE_PAYLOADS) == 1, "the second instance was built, not moved"

    server._MESH_CACHE.clear()
    server._INSTANCE_PAYLOADS.clear()
    fresh = server._body_payload(_body("c", placed), TOL, PROFILE)["payload"]
    _compare(moved, fresh)
    print("  moved instance payload matches a fresh build")


def test_a_mirrored_instance_is_built_from_scratch():
    from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf
    from OCP.TopLoc import TopLoc_Location

    base = _part()
    t = gp_Trsf()
    t.SetMirror(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)))
    mirrored = type(base)(base.wrapped.Moved(TopLoc_Location(t)))
    key, _ = server._instance_key(mirrored, 0.002, PROFILE)
    assert key is None, "a mirrored placement must not reuse an unmirrored payload"
    print("  mirrored instance is not reused")


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
    print("instance payload:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
