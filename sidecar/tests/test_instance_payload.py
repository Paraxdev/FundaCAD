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
import viewport_mesh

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


def test_helper_payloads_match_the_serial_ones():
    """Bodies meshed in helper processes carry exactly the payload the serial
    loop builds, faceOwners included."""
    from build123d import Sphere

    sphere = Sphere(9)
    shapes = [sphere.moved(Location((x, 0, 0))) for x in (0, 30, 60, 90)]
    shapes += [_part().moved(Location((0, 50 + 30 * k, 0), (0, 0, 1), 11 * k)) for k in range(3)]
    shapes += [Box(5 + k, 6, 7).moved(Location((0, -40, 10 * k))) for k in range(4)]
    body_list = [{"id": f"body{i + 1}", "name": f"B{i}", "shape": s, "owners": {}} for i, s in enumerate(shapes)]

    def run(min_faces):
        server._MESH_CACHE.clear()
        old = viewport_mesh._PARALLEL_MIN_FACES
        viewport_mesh._PARALLEL_MIN_FACES = min_faces
        try:
            server._INSTANCE_PAYLOADS.clear()
            server._parallel_payloads(body_list, TOL, PROFILE)
            got = len(server._PRECOMPUTED)
            out = {b["id"]: server._body_payload(b, TOL, PROFILE)["payload"] for b in body_list}
            server._PRECOMPUTED.clear()
            return got, out
        finally:
            viewport_mesh._PARALLEL_MIN_FACES = old

    helped, parallel = run(0)
    assert helped >= 2, f"the helpers built {helped} payloads, the test did not exercise them"
    unhelped, serial = run(10**9)
    assert unhelped == 0
    for bid in serial:
        _compare(parallel[bid], serial[bid])
        assert parallel[bid]["faceOwners"] == serial[bid]["faceOwners"], bid
    print(f"  {helped} helper payloads match the serial loop")


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
