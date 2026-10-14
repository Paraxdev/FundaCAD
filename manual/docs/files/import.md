# Import

Use File, Import Mesh, or Import Mesh under Insert on the rail.

<!-- shot: import-step | imported STEP parts listed as bodies -->

FundaCAD reads STEP, IGES, BREP, FreeCAD files, STL, 3MF, OBJ, PLY, OFF, AMF and glTF (.glb or .gltf), and the file arrives as a new body. A STEP file is the better choice when you have one, because it keeps real faces and edges to pick. A STEP assembly comes in as one body per part, with its colours as materials.

An IGES file comes in the same way, one body per named part with its colours. A FreeCAD file brings in what was showing when it was saved, one body per object, named as in FreeCAD.

An AMF file comes in as one body per object, with the object's name and colour. A PLY or OFF file is one body, coloured with the colour most of its faces carry. A .gltf file reads its buffers from inside itself or from files in its own folder, never from anywhere else.

Some converters write a STEP file as loose faces that only touch. FundaCAD joins them, and a part that closes becomes a solid you can cut and measure. A part that stays open comes in as a surface, and the import's chip in the history says how many edges are still open. An edge the converter drew off its faces, such as a straight line where two round faces meet, is redrawn where those faces meet, and the chip says how many.

A part whose faces all point inward, which some exporters write for a mirrored part, comes in turned the right way out, and the import's chip says so. A part imported before this keeps its faces as they were stored, and its chip still warns that it is inside out.

File, Open also accepts these formats. A `.funda` file replaces what you have open, after asking.
