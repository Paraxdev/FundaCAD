"""Writes tests/fixtures/heal_edge_off.step, the file tests/import_heal.rs reads:
a 20 x 12 x 8 block with a through hole of radius 3, written as loose faces
the way a mesh or drawing converter writes them. Half of the hole's top rim is
drawn as the straight line across it, 3 mm from the hole's wall, and the top
face's outline of the hole runs the wrong way. Needs OCP (cadquery-ocp 7.9).

    python gen_heal_edge_off.py <repo>/tests/fixtures

It prints the volume the test holds the import to.
"""
import math
import sys

from OCP.BRep import BRep_Builder, BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepBuilderAPI import BRepBuilderAPI_Copy
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.BRepTools import BRepTools
from OCP.GC import GC_MakeSegment
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Plane
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.ShapeUpgrade import ShapeUpgrade_ShapeDivideClosed
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_WIRE
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Face, TopoDS_Shell, TopoDS_Solid
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt


def subs(shape, kind):
    out, ex = [], TopExp_Explorer(shape, kind)
    while ex.More():
        out.append(ex.Current())
        ex.Next()
    return out


def volume(shape):
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return props.Mass()


def block():
    box = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 20, 12, 8).Shape()
    hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(6, 6, -1), gp_Dir(0, 0, 1)), 3, 10).Shape()
    cut = BRepAlgoAPI_Cut(box, hole).Shape()
    # The hole's wall in two halves, so each half of its rim runs between two corners.
    split = ShapeUpgrade_ShapeDivideClosed(cut)
    split.SetNbSplitPoints(1)
    split.Perform()
    return split.Result()


def top_of(shape):
    for f in subs(shape, TopAbs_FACE):
        s = BRepAdaptor_Surface(TopoDS.Face_s(f))
        if s.GetType() == GeomAbs_Plane and abs(s.Plane().Location().Z() - 8) < 1e-9 and abs(s.Plane().Axis().Direction().Z()) > 0.5:
            return TopoDS.Face_s(f)
    raise RuntimeError('no top face')


def chord_across(shape):
    """Half of the top rim, its curve swapped for the line between its ends."""
    for e in subs(top_of(shape), TopAbs_EDGE):
        e = TopoDS.Edge_s(e)
        if BRepAdaptor_Curve(e).GetType() != GeomAbs_Circle:
            continue
        a = BRep_Tool.Pnt_s(TopExp.FirstVertex_s(e))
        b = BRep_Tool.Pnt_s(TopExp.LastVertex_s(e))
        line = GC_MakeSegment(a, b).Value()
        builder = BRep_Builder()
        builder.UpdateEdge(e, line, 3.5)
        builder.Range(e, line.FirstParameter(), line.LastParameter())
        builder.SameParameter(e, False)
        return a.Distance(b) / 2
    raise RuntimeError('no rim')


def hole_turned(face):
    """`face` with its inner wire running the wrong way."""
    outer = BRepTools.OuterWire_s(face)
    builder = BRep_Builder()
    out = TopoDS_Face()
    builder.MakeFace(out, BRep_Tool.Surface_s(face), BRep_Tool.Tolerance_s(face))
    for w in subs(face, TopAbs_WIRE):
        builder.Add(out, w if w.IsSame(outer) else w.Reversed())
    return out.Oriented(face.Orientation())


def declared_solid(faces):
    builder = BRep_Builder()
    shell = TopoDS_Shell()
    builder.MakeShell(shell)
    for f in faces:
        builder.Add(shell, f)
    shell.Closed(True)
    solid = TopoDS_Solid()
    builder.MakeSolid(solid)
    builder.Add(solid, shell)
    return solid


def write(path, shape, name):
    app = XCAFApp_Application.GetApplication_s()
    doc = TDocStd_Document(TCollection_ExtendedString('XCAF'))
    app.NewDocument(TCollection_ExtendedString('MDTV-XCAF'), doc)
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    label = shapes.AddShape(shape, False)
    TDataStd_Name.Set_s(label, TCollection_ExtendedString(name))
    writer = STEPCAFControl_Writer()
    writer.SetNameMode(True)
    Interface_Static.SetIVal_s('write.surfacecurve.mode', 0)
    assert writer.Transfer(doc, STEPControl_AsIs)
    assert writer.Write(path) == IFSelect_RetDone


source = block()
print('block volume', repr(volume(source)), 'want', repr(20 * 12 * 8 - math.pi * 9 * 8))
shape = BRepBuilderAPI_Copy(source, True).Shape()
print('rim chord', chord_across(shape), 'mm from the wall at its middle')
top = top_of(shape)
faces = []
for f in subs(shape, TopAbs_FACE):
    loose = TopoDS.Face_s(BRepBuilderAPI_Copy(f, True).Shape())
    faces.append(hole_turned(loose) if f.IsSame(top) else loose)
compound = TopoDS_Compound()
BRep_Builder().MakeCompound(compound)
BRep_Builder().Add(compound, declared_solid(faces))
write(sys.argv[1] + '/heal_edge_off.step', compound, 'Block')
