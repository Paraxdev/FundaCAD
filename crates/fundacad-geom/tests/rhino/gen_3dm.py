"""Writes the Rhino fixtures tests/import_rhino.rs reads, synthetic shapes only.

    pip install rhino3dm==8.35.0
    python crates/fundacad-geom/tests/rhino/gen_3dm.py

rhino_mix.3dm, millimetres, layers Boxes, Surfaces with a child Trimmed, Meshes:
  box10x20x30   Brep box, layer colour
  cyl           Brep cylinder r5 h12, object colour ff8000
  sphere        Brep sphere r7
  plate_with_hole  Extrusion 20x20x8 with a r4 hole
  cyl_extrusion Extrusion cylinder r3 h10
  bump_surface  untrimmed NURBS surface
  disc          trimmed plane r6 on layer Trimmed
  tetra         mesh tetrahedron, object colour 0ac8c8
rhino_inch.3dm, inches: one 1 x 2 x 3 box on layer Inch.
"""
import os
import rhino3dm as r

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "tests", "fixtures")


def layer(f, name, rgb, parent=None):
    L = r.Layer()
    L.Name = name
    L.Color = (*rgb, 255)
    if parent is not None:
        L.ParentLayerId = f.Layers[parent].Id
    return f.Layers.Add(L)


def attrs(li, name, rgb=None):
    a = r.ObjectAttributes()
    a.LayerIndex = li
    a.Name = name
    if rgb:
        a.ColorSource = r.ObjectColorSource.ColorFromObject
        a.ObjectColor = (*rgb, 255)
    return a


def mix(path):
    f = r.File3dm()
    f.Settings.ModelUnitSystem = r.UnitSystem.Millimeters
    lb = layer(f, "Boxes", (200, 30, 30))
    ls = layer(f, "Surfaces", (30, 200, 30))
    lt = layer(f, "Trimmed", (30, 200, 30), ls)
    lm = layer(f, "Meshes", (30, 30, 200))
    f.Objects.AddBrep(r.Brep.CreateFromBoundingBox(r.BoundingBox(0, 0, 0, 10, 20, 30)), attrs(lb, "box10x20x30"))
    cyl = r.Brep.CreateFromCylinder(r.Cylinder(r.Circle(r.Point3d(50, 0, 0), 5), 12), True, True)
    f.Objects.AddBrep(cyl, attrs(lb, "cyl", (255, 128, 0)))
    f.Objects.AddBrep(r.Brep.CreateFromSphere(r.Sphere(r.Point3d(0, 50, 0), 7)), attrs(lb, "sphere"))
    sq = r.Polyline([r.Point3d(0, 0, 0), r.Point3d(20, 0, 0), r.Point3d(20, 20, 0), r.Point3d(0, 20, 0), r.Point3d(0, 0, 0)])
    ex = r.Extrusion.Create(sq.ToPolylineCurve(), 8, True)
    ex.AddInnerProfile(r.Circle(r.Point3d(10, 10, 0), 4).ToNurbsCurve())
    f.Objects.AddExtrusion(ex, attrs(lb, "plate_with_hole"))
    cylx = r.Extrusion.CreateCylinderExtrusion(r.Cylinder(r.Circle(r.Point3d(80, 0, 0), 3), 10), True, True)
    f.Objects.AddExtrusion(cylx, attrs(lb, "cyl_extrusion"))
    ns = r.NurbsSurface.Create(3, False, 4, 4, 4, 4)
    for i in range(4):
        for j in range(4):
            ns.Points[i, j] = r.Point4d(100 + i * 10, j * 10, 5 if (i in (1, 2) and j in (1, 2)) else 0, 1)
    for k in range(len(ns.KnotsU)):
        ns.KnotsU[k] = 0 if k < 3 else 1
    for k in range(len(ns.KnotsV)):
        ns.KnotsV[k] = 0 if k < 3 else 1
    f.Objects.AddSurface(ns, attrs(ls, "bump_surface"))
    plane = r.Plane(r.Point3d(0, 100, 0), r.Vector3d(0, 0, 1))
    disc = r.Brep.CreateTrimmedPlane(plane, r.Circle(r.Point3d(0, 100, 0), 6).ToNurbsCurve())
    f.Objects.AddBrep(disc, attrs(lt, "disc"))
    m = r.Mesh()
    for p in [(150, 0, 0), (160, 0, 0), (150, 10, 0), (150, 0, 10)]:
        m.Vertices.Add(*map(float, p))
    for a, b, c in [(0, 2, 1), (0, 1, 3), (1, 2, 3), (0, 3, 2)]:
        m.Faces.AddFace(a, b, c)
    m.Normals.ComputeNormals()
    m.Compact()
    f.Objects.AddMesh(m, attrs(lm, "tetra", (10, 200, 200)))
    assert f.Write(path, 7), path


def inch(path):
    f = r.File3dm()
    f.Settings.ModelUnitSystem = r.UnitSystem.Inches
    li = layer(f, "Inch", (90, 90, 90))
    f.Objects.AddBrep(r.Brep.CreateFromBoundingBox(r.BoundingBox(0, 0, 0, 1, 2, 3)), attrs(li, "inch_box"))
    assert f.Write(path, 7), path


if __name__ == "__main__":
    mix(os.path.join(OUT, "rhino_mix.3dm"))
    inch(os.path.join(OUT, "rhino_inch.3dm"))
