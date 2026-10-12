# Your first part

This walk-through makes a small mounting plate, 40 mm by 20 mm and 5 mm thick, with a 6 mm hole through it. It takes about ten minutes and uses the ideas the rest of the manual builds on: sketch a flat shape, give it exact sizes, push it into a solid, and write a file for the slicer.

<!-- shot: first-part-overview | the finished plate in the viewport with the tool rail on the left and the History card showing Sketch and Extrude -->

## Sketch the outline

Start FundaCAD and click New Document in the welcome window. If a document is already open, Ctrl+N does the same. You get an empty view with a floor grid and the tool rail down the left side.

A sketch is a flat drawing that later becomes a solid. Press S and the three origin planes light up. Click the one lying flat on the floor, which is the XY plane, because Z points up in FundaCAD. The rail changes to the sketch tools.

Press R for the rectangle tool, click one corner, move out and click the opposite one. The size does not matter yet, so a rough rectangle is fine. The line of text at the bottom of the view tells you what the active tool wants next.

<!-- shot: first-part-rectangle | the sketch plane seen from above with a rough rectangle drawn on it -->

## Give it exact sizes

Press D for the dimension tool. Click the bottom edge of the rectangle, type 40 and press Enter, and the rectangle jumps to that width. Then click one of the side edges, type 20 and press Enter.

The sketch is now held to those two numbers. You can come back later, change 40 to 45, and the shape follows. The [constraints page](../sketch/constraints.md) explains the other ways to pin a sketch down.

For the hole, press C, click inside the rectangle where the hole should be, then move out and click again. Press D, click the circle and type 6. That number is the diameter, so the hole is 6 mm wide. Where exactly it sits is up to you for now. Putting it a fixed distance from an edge is a job for constraints.

## Make it solid

Press E. That leaves the sketch and starts Extrude in one go. You could also click Exit Sketching on the rail first and press E afterwards.

Click inside the rectangle but outside the circle, so the circle stays empty and becomes the hole. An arrow appears on the shape. Drag it up, or type 5 and press Enter, and the plate gets its thickness.

<!-- shot: first-part-extrude | the extrude arrow dragged up from the sketch with the preview of the plate -->

Hold the right mouse button and drag to orbit around the plate. The middle button pans, the wheel zooms, and Home fits the whole model into the view.

## Change your mind

This is the part of CAD that makes it worth the trouble. Click the Extrude step in the History card and its values open under it. Change the distance from 5 to 8 and the plate gets thicker without any redrawing.

To round a corner, press F, click the edge, then drag or type a radius and press Enter. The fillet lands in the History as its own step, so you can change or remove it later.

## Save and export

Press Ctrl+S and pick a place. FundaCAD saves a `.funda` file, which keeps the whole history and not only the shape, so you can open it later and keep editing.

Then press Ctrl+E, or choose File, Export. The Export window asks for a type, and the default is STL, which every slicer opens. Leave Unit on Millimeter and Refinement on Medium, press Export, and choose where the file goes.

<!-- shot: first-part-export | the Export window with STL selected, Millimeter and Medium refinement -->

Open that file in your slicer and the plate is ready to slice. If your slicer prefers 3MF, that is in the same list, and so is STEP for sharing the exact solid with other CAD programs. The [import and export page](../files/import-export.md) goes through the options.
