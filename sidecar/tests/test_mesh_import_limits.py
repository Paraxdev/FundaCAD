"""What an imported mesh file is allowed to be.

Two gates, and they ask different questions.

MAX_IMPORT_FACES asks "is this ONE body a clean CAD part". It was compared
against the sum over every body in the file, which is the wrong denominator for
a project file: a two-object plate whose bodies are 1,850 and 1,737 faces was
refused at their total of 3,587, while either part imported on its own walked
in. Per body now, and the refusal names the body.

MAX_IMPORT_TOTAL_FACES is the backstop that per-body limiting needs, and it asks
a different question: "can the viewport draw all of this at once". Without it an
organic file split into fifty sub-2,000-face bodies would stroll in at ~100k.

The 3MF counter is the third thing here, and it was blind in a way nothing else
would have caught: every counter read the FIRST .model part, and in the
production extension that Bambu, Orca and PrusaSlicer write that part is a
manifest of build items with no triangles at all.

Run: uv run python tests/test_mesh_import_limits.py
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import os
import struct
import sys
import tempfile
import traceback
import zipfile

import builder
import mesh_import

PASS = "  ok"

# One .model part holding a single triangle, and a root part that holds only
# build items — the shape of a real slicer project.
GEOM = """<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter"><resources><object id="1" type="model"><mesh>
<vertices><vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/></vertices>
<triangles><triangle v1="0" v2="1" v3="2"/></triangles>
</mesh></object></resources></model>"""

MANIFEST = """<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter"><resources/><build>
<item objectid="1"/><item objectid="2"/>
</build></model>"""


def box_stl(path, boxes):
    """A binary STL of `boxes` axis-aligned cubes, as (x0, size) pairs."""
    tris = []
    for x0, s in boxes:
        c = [(x0 + i * s, j * s, k * s) for i in (0, 1) for j in (0, 1) for k in (0, 1)]
        # the six quads of a cube, each as two triangles, wound outward
        quads = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1),
                 (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        for a, b, cc, d in quads:
            tris.append((c[a], c[b], c[cc]))
            tris.append((c[a], c[cc], c[d]))
    with open(path, "wb") as fh:
        fh.write(b"\0" * 80)
        fh.write(struct.pack("<I", len(tris)))
        for t in tris:
            fh.write(struct.pack("<3f", 0.0, 0.0, 0.0))
            for v in t:
                fh.write(struct.pack("<3f", *v))
            fh.write(b"\0\0")


def test_a_3mf_is_counted_over_every_part():
    """The slicers' own layout: a manifest at 3D/3dmodel.model and the geometry
    under 3D/Objects/. Reading the first part alone counted the manifest.

    The control is the count itself: 2 parts of one triangle each read as 4 (one
    long per part, for the <triangles> container), and reading only the root
    would read 0 — which is not a small error, it is the whole file missing."""
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "plate.3mf")
        with zipfile.ZipFile(p, "w") as z:
            z.writestr("3D/3dmodel.model", MANIFEST)
            z.writestr("3D/Objects/object_1.model", GEOM)
            z.writestr("3D/Objects/object_2.model", GEOM)
        n = builder._peek_triangle_count(p, "3mf")
        assert n == 4, n

        # ...and a file whose ONLY part is the manifest still reads as nothing,
        # so the sum is coming from the object parts and not from the items.
        q = os.path.join(d, "manifest-only.3mf")
        with zipfile.ZipFile(q, "w") as z:
            z.writestr("3D/3dmodel.model", MANIFEST)
        assert builder._peek_triangle_count(q, "3mf") == 0
    print(PASS, "a 3MF counts every .model part, not just the first")


def test_the_face_limit_is_per_body_with_a_whole_file_backstop():
    """Two clean six-faced boxes in one file. Squeeze MAX_IMPORT_FACES to 8: the
    sum is 12 and would be refused, the largest single body is 6 and is not.

    Two controls, one for each gate. A limit of 4 refuses the SAME file, and the
    message names which body — so the per-body gate is still a gate. And with
    the per-body limit left open, a whole-file limit of 10 refuses it, so the
    backstop is load-bearing rather than decorative."""
    faces, total = mesh_import.MAX_IMPORT_FACES, mesh_import.MAX_IMPORT_TOTAL_FACES
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "two.stl")
        box_stl(p, [(0.0, 10.0), (40.0, 10.0)])
        try:
            mesh_import.MAX_IMPORT_FACES, mesh_import.MAX_IMPORT_TOTAL_FACES = 8, 10_000
            shape = builder._sew_mesh_file(p)
            per = [len(b.faces()) for b in builder._explode_solids(shape)]
            assert per == [6, 6], per

            mesh_import.MAX_IMPORT_FACES = 4
            try:
                builder._sew_mesh_file(p)
                raise AssertionError("a 6-face body passed a 4-face limit")
            except ValueError as ex:
                assert "body 1 of 2 has 6 faces" in str(ex), str(ex)

            mesh_import.MAX_IMPORT_FACES, mesh_import.MAX_IMPORT_TOTAL_FACES = 8, 10
            try:
                builder._sew_mesh_file(p)
                raise AssertionError("12 faces passed a 10-face whole-file limit")
            except ValueError as ex:
                assert "too much detail" in str(ex), str(ex)
                assert "12 faces across 2 bodies" in str(ex), str(ex)
        finally:
            mesh_import.MAX_IMPORT_FACES, mesh_import.MAX_IMPORT_TOTAL_FACES = faces, total
    print(PASS, "the face limit is per body, and the whole file has its own")


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
    print("mesh import limits:", "OK" if not failed else f"{failed} FAILED")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
