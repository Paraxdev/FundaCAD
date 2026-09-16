"""Blobs imported before the mesh gate still carry faces the mesher cannot draw.

Run: uv run python tests/test_heal_snapped_faces.py

`_canonicalize` used to snap a closed spline band to a cone with malformed pcurves.
Nothing but the mesher noticed, and the result is baked into the stored blob, so a
document imported back then keeps showing a spike tip floating above its part even
though a fresh import of the same file is fine. `heal_snapped` rebuilds such a band
from its surface when the blob is loaded for a build.

The fixture is the broken cone band from a real import, closed with two flat caps
so it is a solid, and nothing else of that design. The controls matter as much as
the repair: a healthy shape must come back as the very same object, byte for byte.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import contextlib
import io
import os
import shutil
import sys
import tempfile
import time

os.environ.setdefault("FUNDACAD_DISK_CACHE", "0")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import font_guard  # noqa: E402, F401
import numpy as np  # noqa: E402

import geomstore  # noqa: E402
import heal_snapped  # noqa: E402
import rebuild_cache  # noqa: E402
from build123d import Box, Compound, Cone, Cylinder, Location, Sphere, Torus, Vertex  # noqa: E402
from mesh_import import _canonical_ok  # noqa: E402
from OCP.BRep import BRep_Builder, BRep_Tool  # noqa: E402
from OCP.BRepCheck import BRepCheck_Analyzer  # noqa: E402
from OCP.BRepExtrema import BRepExtrema_DistShapeShape  # noqa: E402
from OCP.BRepGProp import BRepGProp_Face  # noqa: E402
from OCP.BRepTools import BRepTools  # noqa: E402
from OCP.GeomAPI import GeomAPI_ProjectPointOnSurf  # noqa: E402
from OCP.TopoDS import TopoDS_Compound, TopoDS_Shape  # noqa: E402
from OCP.gp import gp_Pnt, gp_Vec  # noqa: E402

PASS = "  ok"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(HERE, "fixtures", "broken_snapped_cone.brep")
USER_BLOB = os.path.join(os.environ.get("APPDATA", ""), "dev.fundacad.app", "blobs",
                         "e2c895784bc8c8ba20b6d85c5ed271dc.bbrep")


def load_fixture():
    shape = TopoDS_Shape()
    BRepTools.Read_s(shape, FIXTURE, BRep_Builder())
    return shape


def volume(shape):
    return sum(s.volume for s in Compound(shape).solids())


def viewport_band(shape, fid, cap_z):
    """Triangles, inward facing ones, and ones flat in the cap plane, for face `fid`
    meshed at viewport settings."""
    import viewport_mesh
    from tessellate import tessellate

    pos, idx, fids = tessellate(Compound(shape), 0.002, angular_tolerance=viewport_mesh._VIEWPORT_ANG_TOL,
                                density_cap=viewport_mesh.VIEWPORT_DENSITY_CAP,
                                relative=viewport_mesh._VIEWPORT_RELATIVE, force_remesh=True)
    P = np.array(pos).reshape(-1, 3)
    T = np.array(idx).reshape(-1, 3)[np.array(fids) == fid]
    fn = np.cross(P[T[:, 1]] - P[T[:, 0]], P[T[:, 2]] - P[T[:, 0]])
    face = heal_snapped._faces(shape)[fid]
    surf = BRep_Tool.Surface_s(face)
    props = BRepGProp_Face(face)
    inward = 0
    for k, c in enumerate(P[T].mean(axis=1)):
        u, v = GeomAPI_ProjectPointOnSurf(gp_Pnt(*c), surf).LowerDistanceParameters()
        p, n = gp_Pnt(), gp_Vec()
        props.Normal(u, v, p, n)
        inward += float(np.dot(fn[k], n.Coord())) < 0
    flat = int(np.sum(np.all(np.abs(P[T][:, :, 2] - cap_z) < 1e-3, axis=1)))
    return len(T), inward, flat


def test_the_fixture_band_is_rebuilt():
    shape = load_fixture()
    bad = heal_snapped.failing_faces(shape)
    assert len(bad) == 1 and heal_snapped._kind(bad[0]) == "GeomAbs_Cone", "the fixture no longer reproduces the broken band"
    band = bad[0]
    rebuilt = heal_snapped.rebuild_band(band)
    assert rebuilt is not None, "a full turn band between two parallels was not recognised"
    new, tol = rebuilt
    assert heal_snapped.face_meshes(new), "the rebuilt band still does not mesh"
    a_old, a_new = heal_snapped._area(band), heal_snapped._area(new)
    assert abs(a_new - a_old) <= 0.005 * a_old, f"area {a_old} became {a_new}"
    def rims(face):
        return [e for e in Compound(face).edges() if not BRep_Tool.IsClosed_s(e.wrapped, face)]

    worst = 0.0
    for src, dst in ((band, new), (new, band)):
        for e in rims(src):
            for t in range(9):
                p = e.position_at(t / 8)
                v = Vertex(p.X, p.Y, p.Z).wrapped
                worst = max(worst, min(BRepExtrema_DistShapeShape(v, o.wrapped).Value() for o in rims(dst)))
    assert worst <= tol, f"a boundary edge moved {worst}, more than the tolerance {tol}"
    print(f"{PASS} the broken cone band meshes after rebuilding, area {a_old:.4f} -> {a_new:.4f}, boundary within {worst:.5f} (tol {tol:.5f})")


def test_the_fixture_solid_is_healed():
    shape = load_fixture()
    healed, solids, stuck = heal_snapped.heal_shape(shape)
    assert healed is not shape and solids == 1 and stuck == 0
    assert BRepCheck_Analyzer(healed).IsValid(), "the healed solid is not valid"
    assert _canonical_ok(Compound(healed), Compound(shape)), "face count or volume changed"
    assert len(heal_snapped._faces(healed)) == len(heal_snapped._faces(shape))
    assert not heal_snapped.failing_faces(healed), "a face still does not mesh"
    for i, (a, b) in enumerate(zip(heal_snapped._faces(shape), heal_snapped._faces(healed))):
        assert heal_snapped._kind(a) == heal_snapped._kind(b), f"face {i} changed kind, the stored face order was lost"
    print(f"{PASS} the fixture solid heals: valid, same faces in the same order, volume {volume(shape):.5f} -> {volume(healed):.5f}")


def as_bytes(shape):
    return geomstore.serialize_shape(shape)


def test_healthy_shapes_are_untouched():
    """THE control: nothing that meshes may be rebuilt, not even to an equal shape."""
    cut = Cylinder(5, 10) - Box(20, 20, 20).moved(Location((0, 0, 10), (30, 0, 0)))
    for label, solid in (
        ("cylinder", Cylinder(5, 10)),
        ("cone", Cone(5, 2, 8)),
        ("thin cone", Cone(0.94, 0.697, 0.45)),
        ("torus", Torus(10, 2)),
        ("sphere", Sphere(4)),
        ("slanted cut cylinder", cut),
        ("compound", Compound([Cylinder(2, 3), Torus(6, 1).moved(Location((20, 0, 0)))])),
    ):
        before = as_bytes(solid.wrapped)
        healed, solids, stuck = heal_snapped.heal_shape(solid.wrapped)
        assert healed is solid.wrapped and solids == 0 and stuck == 0, f"{label}: a healthy shape was rebuilt"
        assert as_bytes(solid.wrapped) == before, f"{label}: the check changed the stored shape"
        print(f"{PASS} {label}: left byte for byte untouched")


def test_a_failing_face_that_is_not_a_band_is_left_and_logged_once():
    """A slanted cut leaves an elliptical rim, which no V range describes."""
    cut = Cylinder(5, 10) - Box(20, 20, 20).moved(Location((0, 0, 10), (30, 0, 0)))
    real = heal_snapped.face_meshes
    heal_snapped.face_meshes = lambda f: False
    err = io.StringIO()
    try:
        with contextlib.redirect_stderr(err):
            before = as_bytes(cut.wrapped)
            out = heal_snapped.heal_stored("0" * 32, cut.wrapped)
            again = heal_snapped.heal_stored("0" * 32, cut.wrapped)
    finally:
        heal_snapped.face_meshes = real
        heal_snapped._memo.clear()
    assert out is cut.wrapped and again is cut.wrapped and as_bytes(cut.wrapped) == before
    assert heal_snapped.rebuild_band(next(f for f in heal_snapped._faces(cut.wrapped)
                                          if heal_snapped._kind(f) == "GeomAbs_Cylinder")) is None
    lines = [ln for ln in err.getvalue().splitlines() if ln.startswith("[heal]")]
    assert len(lines) == 1 and "left as stored" in lines[0], lines
    print(f"{PASS} a failing face that is not a band is kept, logged once: {lines[0]}")


def test_a_shared_solid_is_healed_once_and_keeps_its_placements():
    solid = load_fixture()
    moved = solid.Moved(Location((10, 0, 0)).wrapped)
    comp = TopoDS_Compound()
    b = BRep_Builder()
    b.MakeCompound(comp)
    b.Add(comp, Box(1, 1, 1).wrapped)
    b.Add(comp, solid)
    b.Add(comp, moved)
    healed, solids, stuck = heal_snapped.heal_shape(comp)
    assert solids == 1 and stuck == 0, (solids, stuck)
    kids = Compound(healed).solids()
    assert len(kids) == 3 and not heal_snapped.failing_faces(healed)
    assert kids[0].wrapped.IsSame(Compound(comp).solids()[0].wrapped), "an untouched child was rebuilt"
    shift = kids[2].center().X - kids[1].center().X
    assert abs(shift - 10) < 1e-6 and kids[1].wrapped.IsPartner(kids[2].wrapped), shift
    print(f"{PASS} two instances of one broken solid heal once and keep their placements")


def test_the_verdict_is_cached_per_blob():
    tmp = tempfile.mkdtemp()
    real_store, real_fail = rebuild_cache._disk_store, heal_snapped.failing_faces
    store = geomstore.Store(tmp)
    rebuild_cache._disk_store = lambda: store
    scans = []
    heal_snapped.failing_faces = lambda s: (scans.append(1), real_fail(s))[1]
    try:
        with contextlib.redirect_stderr(io.StringIO()):
            first = heal_snapped.heal_stored("1" * 32, load_fixture())
            n_first = len(scans)
            heal_snapped.heal_stored("1" * 32, load_fixture())
            assert len(scans) == n_first, "a second load in the same process scanned again"
            heal_snapped._memo.clear()
            from_disk = heal_snapped.heal_stored("1" * 32, load_fixture())
            assert len(scans) == n_first, "a new process scanned again instead of reading the verdict"
            assert not real_fail(from_disk) and len(heal_snapped._faces(from_disk)) == len(heal_snapped._faces(first))
            heal_snapped._memo.clear()
            clean = Cylinder(5, 10).wrapped
            assert heal_snapped.heal_stored("2" * 32, clean) is clean
            heal_snapped._memo.clear()
            n = len(scans)
            assert heal_snapped.heal_stored("2" * 32, clean) is clean and len(scans) == n
    finally:
        rebuild_cache._disk_store, heal_snapped.failing_faces = real_store, real_fail
        heal_snapped._memo.clear()
        store.db.close()
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{PASS} healed and clean verdicts are served from memory and from disk without rescanning")


def test_an_import_feature_loads_the_healed_shape():
    import blobstore
    import import_feature

    tmp = tempfile.mkdtemp()
    real = blobstore.default_store
    store = blobstore.BlobStore(tmp)
    blobstore.default_store = lambda: store
    try:
        digest = store.put_bytes(geomstore.serialize_shape(load_fixture()))
        with contextlib.redirect_stderr(io.StringIO()):
            shape = import_feature._import_shape({"geom": digest})
        assert not heal_snapped.failing_faces(shape.wrapped), "the import feature built the broken band"
    finally:
        blobstore.default_store = real
        heal_snapped._memo.clear()
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"{PASS} an import feature builds the healed shape from its blob")


def test_the_users_blob():
    if not os.path.exists(USER_BLOB):
        print(f"  skip the user's blob is not on this machine ({USER_BLOB})")
        return
    data = open(USER_BLOB, "rb").read()
    original = geomstore.deserialize_shape(data)
    t0 = time.perf_counter()
    with contextlib.redirect_stderr(io.StringIO()):
        healed = heal_snapped.heal_stored("e2c895784bc8c8ba20b6d85c5ed271dc", geomstore.deserialize_shape(data))
    cold = (time.perf_counter() - t0) * 1000
    heal_snapped._memo.clear()
    assert BRepCheck_Analyzer(healed).IsValid()
    assert len(Compound(healed).solids()) == 1 and len(heal_snapped._faces(healed)) == 55
    v0, v1 = volume(original), volume(healed)
    assert abs(v1 - v0) <= 0.005 * v0, (v0, v1)
    before = viewport_band(original, 3, 45.39)
    after = viewport_band(healed, 3, 45.39)
    assert after[1] == 0 and after[2] == 0 and after[0] > 0, after
    print(f"{PASS} the user's blob heals in {cold:.0f} ms: valid, 55 faces, volume {v0:.3f} -> {v1:.3f}, "
          f"tip band (triangles, inward, flat in cap) {before} -> {after}")


if __name__ == "__main__":
    print("heal snapped faces: old blobs with a band the mesher cannot draw")
    test_the_fixture_band_is_rebuilt()
    test_the_fixture_solid_is_healed()
    test_healthy_shapes_are_untouched()
    test_a_failing_face_that_is_not_a_band_is_left_and_logged_once()
    test_a_shared_solid_is_healed_once_and_keeps_its_placements()
    test_the_verdict_is_cached_per_blob()
    test_an_import_feature_loads_the_healed_shape()
    test_the_users_blob()
    print("all heal snapped face tests passed")
