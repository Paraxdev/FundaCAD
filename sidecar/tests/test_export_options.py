"""Mesh export options: output units, ASCII or binary STL, and the three faceting controls.

Run: uv run python test_export_options.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import os
import shutil
import struct
import sys
import tempfile
import zipfile

os.environ.setdefault("FUNDACAD_DISK_CACHE", "0")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np  # noqa: E402

import server  # noqa: E402

PASS = "  ok"


def _doc(features):
    return {"parameters": {}, "features": features}


BOX = _doc([{"id": "b", "type": "box", "length": 20, "width": 20, "height": 20}])
CYL = _doc([{"id": "c", "type": "cylinder", "radius": 10, "height": 20}])


def _read_binary_stl(path):
    with open(path, "rb") as fh:
        fh.read(80)
        (n,) = struct.unpack("<I", fh.read(4))
        rec = np.frombuffer(fh.read(), dtype=[("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")], count=n)
    return rec["v"]


def _export(doc, fmt, mesh, name):
    d = tempfile.mkdtemp()
    path = os.path.join(d, name)
    res = server._export_job(doc, fmt, path, mesh=mesh)
    assert "error" not in res, res
    return d, path


def test_units_scale_the_coordinates():
    d, path = _export(BOX, "stl", {"unit": "in"}, "box.stl")
    try:
        v = _read_binary_stl(path)
        span = float(v[..., 0].max() - v[..., 0].min())
        assert abs(span - 20 / 25.4) < 1e-4, span
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print(f"{PASS} inches divide millimetres by 25.4")


def test_3mf_declares_its_unit():
    d, path = _export(BOX, "3mf", {"unit": "cm"}, "box.3mf")
    try:
        with zipfile.ZipFile(path) as z:
            model = z.read("3D/3dmodel.model").decode("utf-8")
        assert 'unit="centimeter"' in model
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print(f"{PASS} 3MF names the unit it was written in")


def test_ascii_stl():
    d, path = _export(BOX, "stl", {"binary": False}, "box.stl")
    try:
        with open(path, encoding="ascii") as fh:
            text = fh.read()
        assert text.startswith("solid ") and text.rstrip().endswith("endsolid FundaCAD")
        assert text.count("facet normal") == 12, text.count("facet normal")
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print(f"{PASS} ASCII STL writes the same twelve facets of a box")


def _cyl_tris(mesh):
    d, path = _export(CYL, "stl", mesh, "cyl.stl")
    try:
        return len(_read_binary_stl(path))
    finally:
        shutil.rmtree(d, ignore_errors=True)


def test_normal_deviation_refines_curved_faces():
    coarse = _cyl_tris({"normalDeviation": 30, "surfaceDeviation": 5})
    fine = _cyl_tris({"normalDeviation": 3, "surfaceDeviation": 5})
    assert fine > coarse * 3, (coarse, fine)
    print(f"{PASS} a smaller normal deviation facets a cylinder finer ({coarse} -> {fine})")


def test_surface_deviation_refines_curved_faces():
    coarse = _cyl_tris({"normalDeviation": 90, "surfaceDeviation": 1})
    fine = _cyl_tris({"normalDeviation": 90, "surfaceDeviation": 0.005})
    assert fine > coarse * 3, (coarse, fine)
    print(f"{PASS} a smaller surface deviation facets a cylinder finer ({coarse} -> {fine})")


def test_max_edge_length_caps_every_facet():
    d, path = _export(BOX, "stl", {"maxEdgeLength": 4}, "box.stl")
    try:
        v = _read_binary_stl(path).astype(np.float64)
        longest = max(
            np.linalg.norm(v[:, 0] - v[:, 1], axis=1).max(),
            np.linalg.norm(v[:, 1] - v[:, 2], axis=1).max(),
            np.linalg.norm(v[:, 2] - v[:, 0], axis=1).max(),
        )
        assert longest <= 4 + 1e-4, longest
    finally:
        shutil.rmtree(d, ignore_errors=True)
    print(f"{PASS} no facet edge is longer than the maximum cell size")


def test_bad_options_fall_back_to_defaults():
    o = server._mesh_options({"unit": "parsec", "surfaceDeviation": "x", "normalDeviation": float("nan"), "maxEdgeLength": -3})
    assert o["unit"] == "mm" and o["tol"] == server._EXPORT_TOL and o["max_edge"] == 0 and o["binary"]
    print(f"{PASS} unreadable options fall back to the defaults")


if __name__ == "__main__":
    print("export options")
    test_units_scale_the_coordinates()
    test_3mf_declares_its_unit()
    test_ascii_stl()
    test_normal_deviation_refines_curved_faces()
    test_surface_deviation_refines_curved_faces()
    test_max_edge_length_caps_every_facet()
    test_bad_options_fall_back_to_defaults()
    print("all export option tests passed")
