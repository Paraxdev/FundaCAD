# Import

Use File, Import Mesh, or Import Mesh under Insert on the rail.

<!-- shot: import-step | imported STEP parts listed as bodies -->

FundaCAD reads STL, 3MF, STEP, OBJ and GLB, and the file arrives as a new body. A STEP file is the better choice when you have one, because it keeps real faces and edges to pick. A STEP assembly comes in as one body per part, with its colours as materials.

Some converters write a STEP file as loose faces that only touch. FundaCAD joins them, and a part that closes becomes a solid you can cut and measure. A part that stays open comes in as a surface, and the import's chip in the history says how many edges are still open. An edge the converter drew off its faces, such as a straight line where two round faces meet, is redrawn where those faces meet, and the chip says how many.

A part whose faces all point inward, which some exporters write for a mirrored part, comes in turned the right way out, and the import's chip says so. A part imported before this keeps its faces as they were stored, and its chip still warns that it is inside out.

File, Open also accepts these formats. A `.funda` file replaces what you have open, after asking.
