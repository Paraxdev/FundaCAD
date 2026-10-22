# Import

| File type | Comes in as | Note |
| --- | --- | --- |
| STEP (.step, .stp, .stpz, .step.gz) | Solid | One body per part, with its colours. Preferred over a mesh when you have one. |
| IGES (.iges, .igs) | Solid | One body per named part, with its colours. |
| BREP (.brep), OCCT XBF (.xbf) | Solid | XBF is scaled to millimetres. |
| FreeCAD (.FCStd) | Solid | One body per object, named as in FreeCAD. |
| Rhino (.3dm) | Solid | Solids, surfaces and meshes, grouped by layer. SubD objects and curves are left out. |
| IFC (.ifc) | Solid | One body per building element. Unzip an .ifczip first. |
| STL, 3MF, OBJ, PLY, OFF, AMF | Mesh | An AMF file keeps each object's name and colour. |
| glTF (.glb, .gltf), VRML (.wrl, .wrz), X3D (.x3d, .x3dz) | Mesh | None of them say their unit, so FundaCAD asks. |
| FBX (.fbx), 3DS (.3ds) | Mesh | One body per mesh or object. A 3DS file is read as millimetres. |
| A mesh over 150,000 triangles | Reference scan | Read-only, up to about 10 million triangles. |
| DXF (.dxf), SVG (.svg) | Sketch | One sketch per layer or top level group, in millimetres. |

Choose File, Import Mesh, or Import Mesh under Insert on the rail, and pick a file. File, Open lists the same formats, and you can also drop a file onto the window. Several dropped files come in one after another.

From Home, the file goes into the empty document FundaCAD starts with, which takes the file's name. When the document behind Home holds work, FundaCAD asks whether to add the file to it or start a new document with it.

<!-- shot: import-step | imported STEP parts listed as bodies -->

Every file arrives as a new body, except a sketch file, which arrives as sketches. Some converters write a STEP file as loose faces that only touch. FundaCAD joins them, and a part that closes becomes a solid you can cut and measure. A part that stays open comes in as a surface, and the import's chip in the history says how many edges are still open.

A reference scan is for looking and measuring. You can snap to it, but you cannot edit it or use it in a boolean, so decimate the mesh first if you need a solid.

## More about

A DXF layer will not extrude while the ends of its lines do not meet, and the import says how many are open. Text, dimensions and hatches in a DXF are left out, and so are the text, images and gradients of an SVG. The import counts what it skipped.
