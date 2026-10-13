"""Writes tests/fixtures/loose_faces_solid.step and loose_faces_mixed.step, the
files tests/import_loose_faces.rs reads: solids whose faces share no edge, the
way a mesh or drawing converter writes them. Needs OCP (cadquery-ocp 7.9).

    python gen_loose_faces.py <repo>/tests/fixtures

It prints the volumes the test holds the import to.
"""
import math
import sys

from OCP.BRep import BRep_Builder
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import (BRepBuilderAPI_Copy, BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeFace,
                                BRepBuilderAPI_MakeWire, BRepBuilderAPI_Transform)
from OCP.BRepFilletAPI import BRepFilletAPI_MakeFillet
from OCP.BRepGProp import BRepGProp
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.Bnd import Bnd_Box
from OCP.GC import GC_MakeArcOfCircle
from OCP.GProp import GProp_GProps
from OCP.Geom import Geom_CylindricalSurface, Geom_Plane
from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Line, GeomAbs_Plane
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.Quantity import Quantity_Color, Quantity_TOC_sRGB
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Shell, TopoDS_Solid
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_ColorGen, XCAFDoc_ColorSurf, XCAFDoc_DocumentTool
from OCP.gp import gp_Ax2, gp_Ax3, gp_Circ, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec


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


def bbox(shape):
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    return box.Get()


def loose(face, flip=False, nudge=False):
    """A copy of `face` that shares nothing with its neighbours."""
    out = BRepBuilderAPI_Copy(face, True).Shape()
    if nudge:
        move = gp_Trsf()
        move.SetTranslation(gp_Vec(3e-4, -2e-4, 2e-4))
        out = BRepBuilderAPI_Transform(out, move, True).Shape()
    return out.Reversed() if flip else out


def loose_faces(solid, flips=(), nudges=()):
    return [loose(f, k in flips, k in nudges) for k, f in enumerate(subs(solid, TopAbs_FACE))]


def declared_solid(faces):
    """What the file calls a closed shell of a solid, whatever its faces do."""
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


def compound(shapes):
    builder = BRep_Builder()
    out = TopoDS_Compound()
    builder.MakeCompound(out)
    for s in shapes:
        builder.Add(out, s)
    return out


def bracket():
    """A 20 x 12 x 8 block with a through hole of radius 3 and one edge rounded at radius 2."""
    box = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 20, 12, 8).Shape()
    hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(6, 6, -1), gp_Dir(0, 0, 1)), 3, 10).Shape()
    cut = BRepAlgoAPI_Cut(box, hole).Shape()
    fillet = BRepFilletAPI_MakeFillet(cut)
    for e in subs(cut, TopAbs_EDGE):
        e = TopoDS.Edge_s(e)
        c = BRepAdaptor_Curve(e)
        a, b = c.Value(c.FirstParameter()), c.Value(c.LastParameter())
        if c.GetType() == GeomAbs_Line and abs(a.X() - 20) < 1e-9 and abs(b.X() - 20) < 1e-9 and abs(a.Z() - b.Z()) > 7:
            fillet.Add(2.0, e)
    return fillet.Shape()


def plug_faces():
    """A plug of radius 4 and height 6 whose top is a cylinder of no height on its rim."""
    plug = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(40, 0, 0), gp_Dir(0, 0, 1)), 4, 6).Shape()
    out = []
    for f in subs(plug, TopAbs_FACE):
        f = TopoDS.Face_s(f)
        if BRepAdaptor_Surface(f).GetType() == GeomAbs_Plane and abs(bbox(f)[2] - 6) < 1e-3:
            at = gp_Ax2(gp_Pnt(40, 0, 6), gp_Dir(0, 0, 1))
            rim = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(gp_Circ(at, 4)).Edge()).Wire()
            out.append(BRepBuilderAPI_MakeFace(Geom_CylindricalSurface(gp_Ax3(at), 4), rim, True).Face())
        else:
            out.append(loose(f))
    return out, volume(plug)


def slot_end():
    """A half round post of radius 2 and height 5 standing on z = 0, with a back
    that bows out a little. It has no bottom face: the round face is said to end
    on the back's bottom edge, which crosses 2 mm from it."""
    r, h, big = 2.0, 5.0, 145.0
    yc = math.sqrt(big * big - r * r)
    def at(x, y, z):
        return gp_Pnt(80 + x, y, z)
    def arc(a, m, b):
        return BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(a, m, b).Value()).Edge()
    def line(a, b):
        return BRepBuilderAPI_MakeEdge(a, b).Edge()
    def wire(*edges):
        w = BRepBuilderAPI_MakeWire()
        for e in edges:
            w.Add(e)
        assert w.IsDone()
        return w.Wire()
    def edges():
        return dict(
            up=line(at(r, 0, 0), at(r, 0, h)),
            down=line(at(-r, 0, h), at(-r, 0, 0)),
            round_top=arc(at(r, 0, h), at(0, r, h), at(-r, 0, h)),
            back_top=arc(at(-r, 0, h), at(0, yc - big, h), at(r, 0, h)),
            back_bottom=arc(at(-r, 0, 0), at(0, yc - big, 0), at(r, 0, 0)),
        )
    e = edges()
    round_face = BRepBuilderAPI_MakeFace(
        Geom_CylindricalSurface(gp_Ax3(at(0, 0, 0), gp_Dir(0, 0, 1)), r),
        wire(e['up'], e['round_top'], e['down'], e['back_bottom']), True).Face()
    e = edges()
    back = BRepBuilderAPI_MakeFace(
        Geom_CylindricalSurface(gp_Ax3(at(0, yc, 0), gp_Dir(0, 0, 1)), big),
        wire(e['back_bottom'], e['up'], e['back_top'], e['down']), True).Face()
    e = edges()
    top = BRepBuilderAPI_MakeFace(Geom_Plane(gp_Ax3(at(0, 0, h), gp_Dir(0, 0, 1))),
                                  wire(e['round_top'], e['back_top']), True).Face()
    turn = 2 * math.asin(r / big)
    area = math.pi * r * r / 2 + big * big / 2 * (turn - math.sin(turn))
    return [round_face, back, top], area * h


def tray_faces():
    """A 10 x 10 x 4 box without its top."""
    box = BRepPrimAPI_MakeBox(gp_Pnt(100, 0, 0), 10, 10, 4).Shape()
    return [loose(f) for f in subs(box, TopAbs_FACE) if not (abs(bbox(f)[2] - 4) < 1e-3 and abs(bbox(f)[5] - 4) < 1e-3)]


def write(path, shape, name, colours):
    app = XCAFApp_Application.GetApplication_s()
    doc = TDocStd_Document(TCollection_ExtendedString('XCAF'))
    app.NewDocument(TCollection_ExtendedString('MDTV-XCAF'), doc)
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    tool = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    label = shapes.AddShape(shape, False)
    TDataStd_Name.Set_s(label, TCollection_ExtendedString(name))
    for sub, rgb, kind in colours:
        tool.SetColor(sub, Quantity_Color(*rgb, Quantity_TOC_sRGB), kind)
    writer = STEPCAFControl_Writer()
    writer.SetColorMode(True)
    writer.SetNameMode(True)
    # Curves in space only, as such converters write them, so the reader has to
    # lay every edge on its face itself.
    Interface_Static.SetIVal_s('write.surfacecurve.mode', 0)
    assert writer.Transfer(doc, STEPControl_AsIs)
    assert writer.Write(path) == IFSelect_RetDone


out = sys.argv[1]
source = bracket()
print('bracket volume', repr(volume(source)), 'faces', len(subs(source, TopAbs_FACE)))
# two faces turned inside out, two moved 0.4 micron
write(out + '/loose_faces_solid.step', compound(loose_faces(source, flips=(1, 4), nudges=(2, 5))), 'Bracket', [])

faces = loose_faces(source, flips=(3,))
hole = next(f for f in faces if BRepAdaptor_Surface(TopoDS.Face_s(f)).GetType() == GeomAbs_Cylinder
            and abs(BRepAdaptor_Surface(TopoDS.Face_s(f)).Cylinder().Radius() - 3) < 1e-9)
a = declared_solid(faces)
plug, plug_volume = plug_faces()
b = declared_solid(plug)
slot, slot_volume = slot_end()
c = declared_solid(slot)
d = declared_solid(tray_faces())
print('plug volume', repr(plug_volume))
print('slot end volume', repr(slot_volume))
write(out + '/loose_faces_mixed.step', compound([a, b, c, d]), 'Housing', [
    (a, (0.8, 0.1, 0.1), XCAFDoc_ColorGen),
    (hole, (0.9, 0.8, 0.1), XCAFDoc_ColorSurf),
    (b, (0.1, 0.2, 0.9), XCAFDoc_ColorGen),
    (c, (0.9, 0.5, 0.1), XCAFDoc_ColorGen),
    (d, (0.1, 0.7, 0.2), XCAFDoc_ColorGen),
])
