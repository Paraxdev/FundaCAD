"""Writes tests/fixtures/asm_colors.stpz, asm_colors.step.gz, asm_colors_zip.stpz,
two_parts.xbf and two_parts_m.xbf, the files tests/import_compressed.rs reads.
Needs OCP for the XBF files.

    python gen_compressed.py <repo>/tests/fixtures

The .stpz and .step.gz files are gzip copies of asm_colors.step, what FreeCAD
and KiCad write; asm_colors_zip.stpz holds it as the one entry of a zip.
two_parts.xbf is an OCCT binary XCAF document with a named red block and a
named blue plug and no length unit; two_parts_m.xbf holds the same in metres.
"""
import gzip
import os
import sys
import zipfile

from OCP.BinXCAFDrivers import BinXCAFDrivers
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt
from OCP.PCDM import PCDM_StoreStatus
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
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


def two_parts(out, scale, metres):
    app = XCAFApp_Application.GetApplication_s()
    BinXCAFDrivers.DefineFormat_s(app)
    doc = TDocStd_Document(TCollection_ExtendedString("BinXCAF"))
    app.NewDocument(TCollection_ExtendedString("BinXCAF"), doc)
    # A document made in Python holds no XCAF tools until this.
    app.InitDocument(doc)
    if metres:
        XCAFDoc_DocumentTool.SetLengthUnit_s(doc, 1.0)
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    s = scale
    box = BRepPrimAPI_MakeBox(gp_Pnt(0, 0, 0), 20 * s, 12 * s, 8 * s).Shape()
    cyl = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(40 * s, 6 * s, 0), gp_Dir(0, 0, 1)), 4 * s, 6 * s).Shape()
    for shape, name, rgb in ((box, "Bracket", (0.8, 0.1, 0.1)), (cyl, "Plug", (0.1, 0.2, 0.9))):
        lab = st.AddShape(shape, False)
        TDataStd_Name.Set_s(lab, TCollection_ExtendedString(name))
        ct.SetColor(lab, Quantity_Color(*rgb, Quantity_TOC_RGB), XCAFDoc_ColorGen)
    assert app.SaveAs(doc, TCollection_ExtendedString(out)) == PCDM_StoreStatus.PCDM_SS_OK
    app.Close(doc)


d = sys.argv[1]
compressed(d)
two_parts(os.path.join(d, "two_parts.xbf"), 1.0, False)
two_parts(os.path.join(d, "two_parts_m.xbf"), 0.001, True)
