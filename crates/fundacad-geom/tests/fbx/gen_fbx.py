"""Writes the ASCII FBX fixtures tests/import_mesh_formats.rs reads, synthetic cubes only.

    python crates/fundacad-geom/tests/fbx/gen_fbx.py

fbx_ascii74.fbx   ASCII FBX 7.4, UnitScaleFactor 2.54 (inch), Y up, a 10 unit
                  cube moved 10 along X, material Green, plus one camera.
fbx_ascii61.fbx   the same cube as ASCII FBX 6.1 (Properties60, links by name).
fbx_nounit74.fbx  fbx_ascii74.fbx without UnitScaleFactor, so the FBX
                  centimetre default applies.
fbx_mirror74.fbx  fbx_ascii74.fbx with Lcl Scaling -1,1,1, a mirrored node.
fbx_blender_two.fbx is binary and comes from gen_fbx_blender.py.
"""
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "tests", "fixtures")

V = [(0, 0, 0), (10, 0, 0), (10, 10, 0), (0, 10, 0), (0, 0, 10), (10, 0, 10), (10, 10, 10), (0, 10, 10)]
Q = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
VERTS = ",".join(str(c) for v in V for c in v)
# FBX ends each polygon with the bitwise not of its last index.
IDX = ",".join(",".join(str(i) for i in q[:3]) + f",{-q[3] - 1}" for q in Q)
AXES = [("UpAxis", 1), ("UpAxisSign", 1), ("FrontAxis", 2), ("FrontAxisSign", 1), ("CoordAxis", 0), ("CoordAxisSign", 1)]


def a74(unit="2.54", scale=None):
    props = "".join(f'\t\tP: "{k}", "int", "Integer", "",{v}\n' for k, v in AXES)
    if unit:
        props += f'\t\tP: "UnitScaleFactor", "double", "Number", "",{unit}\n'
    model = '\t\t\tP: "Lcl Translation", "Lcl Translation", "", "A",10,0,0\n'
    if scale:
        model += f'\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",{scale}\n'
    return f"""; FBX 7.4.0 project file
FBXHeaderExtension:  {{
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
}}
GlobalSettings:  {{
\tVersion: 1000
\tProperties70:  {{
{props}\t}}
}}
Objects:  {{
\tGeometry: 100, "Geometry::Cube", "Mesh" {{
\t\tVertices: *24 {{
\t\t\ta: {VERTS}
\t\t}}
\t\tPolygonVertexIndex: *24 {{
\t\t\ta: {IDX}
\t\t}}
\t}}
\tModel: 200, "Model::Cube", "Mesh" {{
\t\tVersion: 232
\t\tProperties70:  {{
{model}\t\t}}
\t}}
\tMaterial: 300, "Material::Green", "" {{
\t\tVersion: 102
\t\tShadingModel: "phong"
\t\tProperties70:  {{
\t\t\tP: "DiffuseColor", "Color", "", "A",0,1,0
\t\t}}
\t}}
\tNodeAttribute: 400, "NodeAttribute::Cam", "Camera" {{
\t\tTypeFlags: "Camera"
\t}}
\tModel: 500, "Model::Cam", "Camera" {{
\t\tVersion: 232
\t}}
}}
Connections:  {{
\tC: "OO",100,200
\tC: "OO",300,200
\tC: "OO",200,0
\tC: "OO",400,500
\tC: "OO",500,0
}}
"""


def a61():
    props = "".join(f'\t\t\tProperty: "{k}", "int", "",{v}\n' for k, v in AXES)
    return f"""; FBX 6.1.0 project file
FBXHeaderExtension:  {{
\tFBXHeaderVersion: 1003
\tFBXVersion: 6100
}}
Objects:  {{
\tModel: "Model::Cube", "Mesh" {{
\t\tVersion: 232
\t\tProperties60:  {{
\t\t\tProperty: "Lcl Translation", "Lcl Translation", "A+",10,0,0
\t\t}}
\t\tVertices: {VERTS}
\t\tPolygonVertexIndex: {IDX}
\t\tLayerElementMaterial: 0 {{
\t\t\tVersion: 101
\t\t\tName: ""
\t\t\tMappingInformationType: "AllSame"
\t\t\tReferenceInformationType: "IndexToDirect"
\t\t\tMaterials: 0
\t\t}}
\t\tLayer: 0 {{
\t\t\tVersion: 100
\t\t\tLayerElement:  {{
\t\t\t\tType: "LayerElementMaterial"
\t\t\t\tTypedIndex: 0
\t\t\t}}
\t\t}}
\t}}
\tMaterial: "Material::Green", "" {{
\t\tVersion: 102
\t\tShadingModel: "phong"
\t\tProperties60:  {{
\t\t\tProperty: "DiffuseColor", "ColorRGB", "",0,1,0
\t\t}}
\t}}
\tGlobalSettings:  {{
\t\tVersion: 1000
\t\tProperties60:  {{
{props}\t\t\tProperty: "UnitScaleFactor", "double", "",2.54
\t\t}}
\t}}
}}
Connections:  {{
\tConnect: "OO", "Model::Cube", "Model::Scene"
\tConnect: "OO", "Material::Green", "Model::Cube"
}}
"""


def write(name, text):
    with open(os.path.join(OUT, name), "w", newline="\n") as f:
        f.write(text)


write("fbx_ascii74.fbx", a74())
write("fbx_ascii61.fbx", a61())
write("fbx_nounit74.fbx", a74(unit=None))
write("fbx_mirror74.fbx", a74(scale="-1,1,1"))
