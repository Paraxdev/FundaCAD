"""Snapping a spline face to an analytic one must leave a face that can be DRAWN.

Run: uv run python tests/test_canonical_mesh_gate.py

_canonicalize rebuilds a near-analytic spline face on a true plane/cylinder/cone
and re-projects the original wire onto it with ShapeFix_Face. On a closed face
whose seam lands badly that re-projection produces malformed pcurves, and the
damage is invisible to every check the gate already ran: BRepCheck says valid,
the face count is unchanged, the volume is identical and even the face's own area
matches to four decimals. Only the mesher disagrees, and it disagrees silently,
by tessellating a region that is not the face.

Measured on a real STEP (a spike tip snapped to a cone): 137 of the face's 155
triangles faced the wrong way and a third of them lay flat in the plane of the
neighbouring cap, two surfaces in one place, which is z-fighting on screen. The
face's normals came out inverted with it, so the tip shaded inside out.

So the gate asks the mesher too. The controls below matter as much as the
rejection: a check that threw away good conversions would cost every imported
STEP the exact analytic surfaces that make Delete Face work.
"""

import _bootstrap  # noqa: F401  (puts sidecar/ on sys.path)

import os
import sys

os.environ.setdefault("FUNDACAD_DISK_CACHE", "0")
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import mesh_import  # noqa: E402
from mesh_import import _conversion_meshes  # noqa: E402
from build123d import Box, Cone, Cylinder, Solid, Torus  # noqa: E402
from OCP.BRep import BRep_Tool  # noqa: E402
from OCP.BRepAdaptor import BRepAdaptor_Surface  # noqa: E402
from OCP.BRepBuilderAPI import (  # noqa: E402
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_NurbsConvert,
)
from OCP.BRepTools import BRepTools  # noqa: E402
from OCP.ShapeCustom import ShapeCustom_Surface  # noqa: E402
from OCP.ShapeFix import ShapeFix_Face  # noqa: E402
from OCP.TopAbs import TopAbs_SOLID, TopAbs_WIRE  # noqa: E402
from OCP.TopExp import TopExp_Explorer  # noqa: E402
from OCP.TopoDS import TopoDS, TopoDS_Face  # noqa: E402

PASS = "  ok"


def as_splines(solid):
    """The same solid with every surface rewritten as a B-spline, which is what a
    STEP writer that emits splines for analytic shapes hands us."""
    res = BRepBuilderAPI_NurbsConvert(solid.wrapped, True).Shape()
    exp = TopExp_Explorer(res, TopAbs_SOLID)
    return Solid(TopoDS.Solid_s(exp.Current()))


def snap(face):
    """One face through the conversion _canonicalize performs, or None when the
    surface is not near-analytic."""
    ana = ShapeCustom_Surface(BRep_Tool.Surface_s(face)).ConvertToAnalytical(1e-3, False)
    if ana is None:
        return None
    outer = BRepTools.OuterWire_s(face)
    mf = BRepBuilderAPI_MakeFace(ana, outer)
    wexp = TopExp_Explorer(face, TopAbs_WIRE)
    while wexp.More():
        w = TopoDS.Wire_s(wexp.Current())
        if not w.IsSame(outer):
            mf.Add(w)
        wexp.Next()
    if not mf.IsDone():
        return None
    fix = ShapeFix_Face(mf.Face())
    fix.Perform()
    return fix.Face()


def test_good_conversions_are_kept():
    """THE control. Planes, cylinders, cones and tori all mesh, and a check that
    rejected any of them would silently stop imports being snapped at all."""
    for label, solid in (
        ("box", Box(10, 8, 6)),
        ("cylinder", Cylinder(5, 10)),
        ("cone frustum", Cone(5, 2, 8)),
        ("thin cone frustum", Cone(0.94, 0.697, 0.45)),
        ("torus", Torus(10, 2)),
    ):
        kinds = []
        for f in as_splines(solid).faces():
            nf = snap(f.wrapped)
            if nf is None:
                continue
            assert _conversion_meshes(nf), f"{label}: a sound {BRepAdaptor_Surface(nf).GetType().name} was rejected"
            kinds.append(BRepAdaptor_Surface(nf).GetType().name.replace("GeomAbs_", ""))
        assert kinds, f"{label}: nothing converted, the control measures nothing"
        print(f"{PASS} {label}: kept {', '.join(sorted(set(kinds)))}")


def test_a_face_that_cannot_be_measured_is_rejected():
    """Any doubt is a NO, the same rule _canonical_ok follows: this decides what
    gets baked into the stored B-rep, so a face nothing can mesh keeps the spline."""
    assert _conversion_meshes(TopoDS_Face()) is False
    print(f"{PASS} a face with no triangulation is rejected, not accepted by accident")


def test_the_gate_runs_on_every_converted_face():
    """The wiring, not the geometry: _canonicalize must consult the mesh check for
    each face it snaps, and a face it refuses must stay a spline.

    Only the per-face decision is measured here. Whether the whole shape is then
    adopted is _canonical_ok's call, which test_canonicalize covers, and on a
    solid rebuilt from NURBS it says no either way."""
    for label, verdict in (("accepting", lambda f: True), ("refusing", lambda f: False)):
        seen = []
        real = mesh_import._conversion_meshes
        mesh_import._conversion_meshes = lambda f: (seen.append(f), verdict(f))[1]
        try:
            mesh_import._canonicalize(as_splines(Cylinder(5, 10)))
        finally:
            mesh_import._conversion_meshes = real
        assert seen, f"{label}: no converted face was mesh-checked"
        snapped = [f for f in seen if BRepAdaptor_Surface(f).GetType().name != "GeomAbs_BSplineSurface"]
        assert snapped, f"{label}: nothing was snapped, the test measures nothing"
        print(f"{PASS} {len(seen)} converted faces checked while {label}")


if __name__ == "__main__":
    print("canonicalise: the mesh gate on a snapped face")
    test_good_conversions_are_kept()
    test_a_face_that_cannot_be_measured_is_rejected()
    test_the_gate_runs_on_every_converted_face()
    print("all canonical mesh-gate tests passed")
