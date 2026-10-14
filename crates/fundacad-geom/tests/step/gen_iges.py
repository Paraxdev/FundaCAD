"""Writes tests/fixtures/two_parts_mode0.igs, two_parts_mode1.igs and
face_soup.igs, the files tests/import_iges.rs reads. Needs OCP.

    python gen_iges.py <repo>/tests/fixtures

two_parts_mode0 holds a named red block and a named blue plug as trimmed
surfaces, what most IGES files are; mode1 holds the same as solids (MSBO 186).
face_soup writes each face of a holed 20 x 12 x 8 block as its own entity.
"""
import os
import sys

from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
from OCP.IGESCAFControl import IGESCAFControl_Writer
from OCP.IGESControl import IGESControl_Controller, IGESControl_Writer
from OCP.Interface import Interface_Static
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.XCAFDoc import XCAFDoc_ColorGen, XCAFDoc_DocumentTool


def two_parts(out, mode):
    Interface_Static.SetIVal_s("write.iges.brep.mode", mode)
    doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    box = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 20, 12, 8).Shape()
    cyl = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(40, 6, 0), gp_Dir(0, 0, 1)), 4, 6).Shape()
    for shape, name, rgb in ((box, "Bracket", (0.8, 0.1, 0.1)), (cyl, "Plug", (0.1, 0.2, 0.9))):
        lab = st.AddShape(shape, False)
        TDataStd_Name.Set_s(lab, TCollection_ExtendedString(name))
        ct.SetColor(lab, Quantity_Color(*rgb, Quantity_TOC_RGB), XCAFDoc_ColorGen)
    w = IGESCAFControl_Writer()
    w.SetColorMode(True)
    w.SetNameMode(True)
    assert w.Transfer(doc) and w.Write(out)


def face_soup(out):
    Interface_Static.SetIVal_s("write.iges.brep.mode", 0)
    box = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 20, 12, 8).Shape()
    hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(10, 6, -1), gp_Dir(0, 0, 1)), 3, 10).Shape()
    solid = BRepAlgoAPI_Cut(box, hole).Shape()
    w = IGESControl_Writer("MM", 0)
    e = TopExp_Explorer(solid, TopAbs_FACE)
    while e.More():
        w.AddShape(e.Current())
        e.Next()
    w.ComputeModel()
    assert w.Write(out)


IGESControl_Controller.Init_s()
d = sys.argv[1]
two_parts(os.path.join(d, "two_parts_mode0.igs"), 0)
two_parts(os.path.join(d, "two_parts_mode1.igs"), 1)
face_soup(os.path.join(d, "face_soup.igs"))
