# Export

Press Ctrl+E, or choose File, Export, to send a part to a slicer or another program.

<!-- shot: export-dialog | Export window set to STL, Medium -->

Type picks the format. STL and 3MF suit slicers, STEP keeps exact surfaces for other CAD programs, and GLB is for viewers. With several bodies you can export all in one file or one file per body.

Leave Unit on Millimeter, since a slicer reads numbers literally. Refinement sets how finely curves are cut into triangles. Medium suits most prints, High suits large smooth curves, and Low suits quick tests.

If a step failed, a warning names it, because its shape is missing from the file.

| Format | Import | Export |
| --- | --- | --- |
| STL, 3MF, STEP, GLB | yes | yes |
| OBJ | yes | no |
