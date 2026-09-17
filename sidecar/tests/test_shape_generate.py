"""The generateShape op: a registered generator, meshed for a preview or stored for an import.

Run: cd sidecar && uv run python tests/test_shape_generate.py
"""

import _bootstrap  # noqa: F401

import math
import os
import shutil
import tempfile

FAILED = []


def check(label, cond):
    print(("  ok   " if cond else "  FAIL ") + label)
    if not cond:
        FAILED.append(label)


def _box(params):
    from build123d import Box, Pos

    w = float(params.get("w", 0))
    if w <= 0:
        raise ValueError("Box: w must be positive")
    return Pos(0, 0, w / 2) * Box(w, w, w)


def _register():
    import plugin_geometry

    plugin_geometry._reset_for_tests()
    plugin_geometry._discovered = True
    plugin_geometry.register_shape_generator("testBox", "Test.Plugin", _box)
    return plugin_geometry


def test_mesh_output():
    from shape_generate import generate_shape

    _register()
    out = generate_shape("testBox", {"w": 10}, "mesh")
    mesh = out["mesh"]
    check("a mesh comes back with triangles", len(mesh["indices"]) >= 36 and len(mesh["indices"]) % 3 == 0)
    check("normals line up with positions", len(mesh["normals"]) == len(mesh["positions"]))
    check("the volume is measured off the solid", abs(out["volume"] - 1000) < 1e-6)
    check("no blob is written for a preview", "geom" not in out)


def test_store_output_rebuilds_as_an_import_without_the_generator():
    from shape_generate import generate_shape

    blobs = tempfile.mkdtemp(prefix="gen_blobs_")
    old = os.environ.get("FUNDACAD_BLOB_DIR")
    os.environ["FUNDACAD_BLOB_DIR"] = blobs
    import blobstore

    blobstore._default = None
    try:
        pg = _register()
        out = generate_shape("testBox", {"w": 10}, "store",
                             {"origin": [5, 0, 0], "zAxis": [1, 0, 0]})
        check("a content hash comes back", isinstance(out.get("geom"), str) and len(out["geom"]) == 32)
        pg._reset_for_tests()
        pg._discovered = True
        check("the generator is gone before the rebuild", pg.generator_for("testBox") is None)
        import builder

        doc = {"parameters": {}, "features": [
            {"id": "im", "type": "import", "format": "brep", "name": "Generated", "geom": out["geom"],
             "solid": True, "generatedBy": {"plugin": "Test.Plugin", "spec": {"w": 10}}}]}
        _part, errors, bodies = builder.rebuild(doc)
        check("the document rebuilds with no errors", not errors)
        check("one body named from the feature", len(bodies) == 1 and bodies[0]["name"] == "Generated")
        bb = bodies[0]["shape"].bounding_box()
        check("the placement carried +Z to +X from the origin point",
              abs(bb.min.X - 5) < 1e-6 and abs(bb.max.X - 15) < 1e-6 and abs(bb.max.Z - 5) < 1e-6)
    finally:
        blobstore._default = None
        if old is None:
            os.environ.pop("FUNDACAD_BLOB_DIR", None)
        else:
            os.environ["FUNDACAD_BLOB_DIR"] = old
        shutil.rmtree(blobs, ignore_errors=True)


def test_refusals_carry_the_message():
    from shape_generate import generate_shape

    _register()
    for label, call, needle in (
        ("an unknown generator is named", lambda: generate_shape("nope", {}), "nope"),
        ("the generator's own ValueError reaches the caller", lambda: generate_shape("testBox", {"w": -1}), "w must be positive"),
        ("an unknown output is refused", lambda: generate_shape("testBox", {"w": 1}, "file"), "unknown output"),
        ("a zero axis is refused", lambda: generate_shape("testBox", {"w": 1}, "mesh", {"zAxis": [0, 0, 0]}), "zAxis"),
    ):
        try:
            call()
            check(label, False)
        except ValueError as ex:
            check(label, needle in str(ex))


def test_a_second_plugin_cannot_take_a_name():
    pg = _register()
    try:
        pg.register_shape_generator("testBox", "Other.Plugin", _box)
        check("a second owner is refused", False)
    except ValueError:
        check("a second owner is refused", True)
    check("the listing names what is registered", pg.shape_generators() == ["testBox"])


def test_placement_along_minus_z():
    from shape_generate import generate_shape

    _register()
    out = generate_shape("testBox", {"w": 4}, "mesh", {"origin": [0, 0, 10], "zAxis": [0, 0, -1]})
    bb = out["bbox"]
    check("pointing down flips the box below the origin point",
          math.isclose(bb["max"][2], 10, abs_tol=1e-6) and math.isclose(bb["min"][2], 6, abs_tol=1e-6))


if __name__ == "__main__":
    import sys

    test_mesh_output()
    test_store_output_rebuilds_as_an_import_without_the_generator()
    test_refusals_carry_the_message()
    test_a_second_plugin_cannot_take_a_name()
    test_placement_along_minus_z()
    import plugin_geometry

    plugin_geometry._reset_for_tests()
    if FAILED:
        print(f"FAILED ({len(FAILED)}):")
        for f in FAILED:
            print("  - " + f)
        sys.exit(1)
    print("all shape generator tests passed")
