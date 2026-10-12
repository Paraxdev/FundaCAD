# Import and export

Parts rarely start from nothing. You download a STEP file of the motor you need to fit around, or you get an STL from a friend, and in the end you send your own part to a slicer.

## Bringing a file in

Use File, Import Mesh, or Import Mesh under Insert on the rail. FundaCAD reads STL, 3MF, STEP (also `.stp`), OBJ and GLB files. The file arrives as a new body, and it gets a step in the History like anything else.

A mesh file such as an STL becomes a body you can measure, move, cut with and export again. A STEP file is the better thing to have when you can get one. It describes real surfaces and not a pile of triangles, so you can still pick single faces and edges on it.

If the STEP file is an assembly, each part comes in as its own body, and colours stored in the file become materials. Very large assemblies work, but the view slows down. FundaCAD tells you after the import if you brought in more than about a thousand bodies, so you know the lag comes from the size of the file.

File, Open accepts these formats too. A `.funda` file takes the place of what you have open, after asking. An STL or STEP file is imported into the current document.

To bring in another FundaCAD document and keep it connected to its source, see [Saving and documents](documents.md#bringing-in-another-document).

## Sending a part out

Choose File, Export, or press Ctrl+E. A small window asks how.

<!-- shot: export-dialog | The Export window with Type set to STL, the Bodies list open and Refinement on Medium -->

Type picks the format. STL and 3MF are the two a slicer wants. STEP keeps exact surfaces, so choose it when someone else will keep modelling the part. GLB is for viewers and other 3D tools.

When your model has more than one body, a second list called Bodies appears. All in one file puts everything into a single file. Each body as its own file writes one file per body, named after the body, which is the quick way to print an assembly part by part. You can also pick a single body from the list.

Unit, which is offered for STL and 3MF, says what a number in the file means, from Millimeter to Foot. A slicer reads the numbers literally, so leave it on Millimeter unless you know yours wants something else. For an STL there is also a Format choice between Binary, which is smaller and the usual pick, and ASCII.

Refinement is how finely curved surfaces are cut into triangles. Medium is the default and is fine for most prints. Choose High for a large smooth curve, such as a big cylinder or a sphere, where flat patches would show, and Low for a quick test print. Advanced opens the exact numbers behind those three, if you need to set them yourself.

Press Export and choose where to save. FundaCAD then lists the files it wrote. If a step in your model failed to build, a warning names it there, because its shape is missing from the file. Fix the red step in the History before you print.

Your choices are remembered, so the next export starts where this one ended.

| Format | Import | Export | Good for |
| --- | --- | --- | --- |
| STL | yes | yes | Slicers |
| 3MF | yes | yes | Slicers |
| STEP | yes | yes | Exact shape, for other CAD programs |
| GLB | yes | yes | Viewers and other 3D tools |
| OBJ | yes | no | Meshes from other 3D tools |

The [Printer connection](../plugins/printing.md) plugin adds Export for Print (3MF) to the File menu, which writes a project file with the colours and filament slots your slicer needs.
