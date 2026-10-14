"""Writes tests/fixtures/inside_out_cube.step and inside_out_parts.step, the
files tests/import_turned_outward.rs reads: solids whose faces all point into
the material, the way some exporters write a mirrored part, and one whose
faces disagree with each other. Also inside_out_cube.brep, the same cube as a
document saved before imports were turned holds it, which the fundacad-mcp
tests build. Needs OCP (cadquery-ocp 7.9).

    python gen_inside_out.py <repo>/tests/fixtures
"""
import sys

from OCP.BRep import BRep_Builder
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.BRepTools import BRepTools
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPCAFControl import STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE, TopAbs_SHELL
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS_Compound, TopoDS_Shell, TopoDS_Solid
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.gp import gp_Pnt


def subs(shape, kind):
    out, ex = [], TopExp_Explorer(shape, kind)
    while ex.More():
        out.append(ex.Current())
        ex.Next()
    return out


def box(x, size):
    return BRepPrimAPI_MakeBox(gp_Pnt(x, 0, 0), size, size, size).Shape()


def solid_of(faces):
    b = BRep_Builder()
    shell, solid = TopoDS_Shell(), TopoDS_Solid()
    b.MakeShell(shell)
    for f in faces:
        b.Add(shell, f)
    shell.Closed(True)
    b.MakeSolid(solid)
    b.Add(solid, shell)
    return solid


def inside_out(shape):
    return solid_of([f.Reversed() for f in subs(shape, TopAbs_FACE)])


def one_face_turned(shape):
    faces = subs(shape, TopAbs_FACE)
    return solid_of([faces[0].Reversed()] + faces[1:])


def compound(shapes):
    b, c = BRep_Builder(), TopoDS_Compound()
    b.MakeCompound(c)
    for s in shapes:
        b.Add(c, s)
    return c


def write(path, shape, name):
    app = XCAFApp_Application.GetApplication_s()
    doc = TDocStd_Document(TCollection_ExtendedString('XCAF'))
    app.NewDocument(TCollection_ExtendedString('MDTV-XCAF'), doc)
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    label = shapes.AddShape(shape, False)
    TDataStd_Name.Set_s(label, TCollection_ExtendedString(name))
    writer = STEPCAFControl_Writer()
    writer.SetNameMode(True)
    assert writer.Transfer(doc, STEPControl_AsIs)
    assert writer.Write(path) == IFSelect_RetDone


out = sys.argv[1]
write(out + '/inside_out_cube.step', inside_out(box(0, 10)), 'Cube')
BRepTools.Write_s(inside_out(box(0, 10)), out + '/inside_out_cube.brep')
# A stored import's inline copy starts at the CASCADE line, without the header.
with open(out + '/inside_out_cube.brep') as f:
    text = f.read()
with open(out + '/inside_out_cube.brep', 'w', newline='\n') as f:
    f.write(text[text.index('CASCADE'):])
# a sound 10 mm cube, a 6 mm cube inside out, an 8 mm cube with one face turned
write(out + '/inside_out_parts.step',
      compound([solid_of(subs(box(0, 10), TopAbs_FACE)), inside_out(box(20, 6)), one_face_turned(box(40, 8))]),
      'Housing')
