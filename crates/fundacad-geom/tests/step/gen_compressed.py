"""Writes tests/fixtures/asm_colors.stpz, asm_colors.step.gz, asm_colors_zip.stpz,
two_parts.xbf, two_parts_m.xbf and shared_inch.xbf, the files
tests/import_compressed.rs reads. Needs OCP for the XBF files.

    python gen_compressed.py <repo>/tests/fixtures

The .stpz and .step.gz files are gzip copies of asm_colors.step, what FreeCAD
and KiCad write; asm_colors_zip.stpz holds it as the one entry of a zip.
two_parts.xbf is an OCCT binary XCAF document with a named red block and a
named blue plug and no length unit; two_parts_m.xbf holds the same in metres.
shared_inch.xbf, in inches, has two root assemblies R1 and R2 that each place
the one 1 inch cube, at x 0 and x 5.
"""
import gzip
import os
import sys
import zipfile

from OCP.BinXCAFDrivers import BinXCAFDrivers
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec
from OCP.PCDM import PCDM_StoreStatus
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFApp import XCAFApp_Application
from OCP.XCAFDoc import XCAFDoc_ColorGen, XCAFDoc_DocumentTool


def compressed(d):
    with open(os.path.join(d, "asm_colors.step"), "rb") as f:
        step = f.read().replace(b"\r\n", b"\n")
    for name in ("asm_colors.stpz", "asm_colors.step.gz"):
        with open(os.path.join(d, name), "wb") as f:
            f.write(gzip.compress(step, mtime=0))
    info = zipfile.ZipInfo("asm_colors.step", date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    with zipfile.ZipFile(os.path.join(d, "asm_colors_zip.stpz"), "w") as z:
        z.writestr(info, step)


def xbf(out, metres_per_unit, fill):
    app = XCAFApp_Application.GetApplication_s()
    BinXCAFDrivers.DefineFormat_s(app)
    doc = TDocStd_Document(TCollection_ExtendedString("BinXCAF"))
    app.NewDocument(TCollection_ExtendedString("BinXCAF"), doc)
    # A document made in Python holds no XCAF tools until this.
    app.InitDocument(doc)
    if metres_per_unit:
        XCAFDoc_DocumentTool.SetLengthUnit_s(doc, metres_per_unit)
    fill(doc)
    assert app.SaveAs(doc, TCollection_ExtendedString(out)) == PCDM_StoreStatus.PCDM_SS_OK
    app.Close(doc)


def two_parts(doc, s):
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    box = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 20 * s, 12 * s, 8 * s).Shape()
    cyl = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(40 * s, 6 * s, 0), gp_Dir(0, 0, 1)), 4 * s, 6 * s).Shape()
    for shape, name, rgb in ((box, "Bracket", (0.8, 0.1, 0.1)), (cyl, "Plug", (0.1, 0.2, 0.9))):
        lab = st.AddShape(shape, False)
        TDataStd_Name.Set_s(lab, TCollection_ExtendedString(name))
        ct.SetColor(lab, Quantity_Color(*rgb, Quantity_TOC_RGB), XCAFDoc_ColorGen)


def shared_cube(doc):
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    cube = st.AddShape(BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape(), False)
    TDataStd_Name.Set_s(cube, TCollection_ExtendedString("Cube"))
    for name, x in (("R1", 0.0), ("R2", 5.0)):
        root = st.NewShape()
        TDataStd_Name.Set_s(root, TCollection_ExtendedString(name))
        t = gp_Trsf()
        t.SetTranslation(gp_Vec(x, 0.0, 0.0))
        st.AddComponent(root, cube, TopLoc_Location(t))
    st.UpdateAssemblies()


d = sys.argv[1]
compressed(d)
xbf(os.path.join(d, "two_parts.xbf"), None, lambda doc: two_parts(doc, 1.0))
xbf(os.path.join(d, "two_parts_m.xbf"), 1.0, lambda doc: two_parts(doc, 0.001))
xbf(os.path.join(d, "shared_inch.xbf"), 0.0254, shared_cube)
