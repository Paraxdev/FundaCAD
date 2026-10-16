# Import

Use File, Import Mesh, or Import Mesh under Insert on the rail.

<!-- shot: import-step | imported STEP parts listed as bodies -->

FundaCAD reads STEP, IGES, BREP, FreeCAD files, Rhino files, IFC building models, STL, 3MF, OBJ, PLY, OFF, AMF, glTF (.glb or .gltf), VRML 2.0 (.wrl), X3D (.x3d), FBX (.fbx, from Maya, 3ds Max or Blender) and 3DS (.3ds, old 3ds Max), and the file arrives as a new body. A STEP file is the better choice when you have one, because it keeps real faces and edges to pick. A STEP assembly comes in as one body per part, with its colours as materials.

A compressed STEP file (.stpz, .step.gz or .stp.gz) reads like the STEP file inside it.

An IGES file comes in the same way, one body per named part with its colours, and so does an OCCT XBF document (.xbf), scaled to millimetres when it was saved in another unit. A FreeCAD file brings in what was showing when it was saved, one body per object, named as in FreeCAD. A Rhino file (.3dm) brings in its solids, surfaces and meshes, one body per object, grouped by layer and coloured as in Rhino. SubD objects and curves are left out, convert a SubD to NURBS in Rhino first. An IFC building model (.ifc) brings in one body per building element, named and coloured as in the BIM tool, with the window and door openings cut. Spaces, openings and other elements that are not material are left out, and a zipped .ifczip has to be unzipped first. An element whose faces do not close comes in as an open shell, and the import says which one.

An AMF file comes in as one body per object, with the object's name and colour. A PLY or OFF file is one body, coloured with the colour most of its faces carry. A .gltf file reads its buffers from inside itself or from files in its own folder, never from anywhere else. glTF, VRML and X3D files do not say what their unit is, so FundaCAD asks each time, with your last choice first. A VRML or X3D scene comes in as one body per top level node, named by its DEF name. Spheres, cylinders, text and linked files in a scene are skipped, and the chip says how many.

An FBX file comes in as one body per mesh, placed where the scene puts it, named after its node and coloured with its material. FBX says what its unit and up direction are, so FundaCAD does not ask, and cameras, lights, bones and animation are left out.

A 3DS file comes in as one body per object, named and coloured the same way. It has no unit of its own, so its numbers are read as millimetres times the file's master scale.

A DXF drawing (.dxf) is different: its lines, arcs, circles, polylines and splines become sketches, one per layer, on the XY plane and named after the layer, so you can edit them and extrude them like your own. Blocks are placed where the drawing puts them, and the drawing's unit is turned into millimetres. Text, dimensions and hatches are left out, and so are paper space layouts. 3D faces and meshes in a DXF come in as bodies. A 3DSOLID cannot be read, export it as STEP from the program that made it. When the ends of a layer's lines do not meet, the import says how many are open, because that layer will not extrude until they do.

An SVG drawing (.svg), like a logo, comes in the same way: one sketch per top level group or Inkscape layer, upright on the XY plane and sized in millimetres. The outlines are tidied so the sketch extrudes into a solid straight away: small gaps are closed, crossings are split, doubled shapes are merged, and the holes of letters like O and A stay open. A shape drawn only as a stroke comes in as a curve without a thickness, in a sketch of its own. Text, images, gradients, filters and clip paths are left out or ignored, and the import says how many.

Some converters write a STEP file as loose faces that only touch. FundaCAD joins them, and a part that closes becomes a solid you can cut and measure. A part that stays open comes in as a surface, and the import's chip in the history says how many edges are still open. An edge the converter drew off its faces, such as a straight line where two round faces meet, is redrawn where those faces meet, and the chip says how many.

A part whose faces all point inward, which some exporters write for a mirrored part, comes in turned the right way out, and the import's chip says so. A part imported before this keeps its faces as they were stored, and its chip still warns that it is inside out.

File, Open also accepts these formats. A `.funda` file replaces what you have open, after asking.
