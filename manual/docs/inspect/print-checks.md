# Print checks

A part can look perfect on screen and still fail on the bed. Three tools help you catch that early. Overhang paints the faces that will sag, Printability goes through the whole model and lists what is likely to go wrong, and Bed Fit Check tells you whether the part fits your printer at all.

## Overhang

Overhang colours every face that leans out too far to print without support. Use it while you are still designing, because turning a part or adding a chamfer is cheap now and expensive after a failed print.

Open Inspect on the rail and pick Overhang. Faces that need support turn red, and a small panel opens with two settings. Build dir is the direction your printer stacks layers, and it starts at +Z, which is up as modelled. Threshold is the angle from horizontal past which a face counts as unsupported, and it starts at 45 degrees.

<!-- shot: overhang-red | A part with its undersides painted red and the Overhang panel showing Build dir and Threshold -->

The red areas update as you drag the slider. Raise the threshold if your printer copes with steeper overhangs, and change Build dir if you plan to print the part on its side. Pick Overhang again to switch the colouring off.

## Printability

Printability is the full check. It looks at the geometry and lists the problems it finds, body by body, so you can fix them before you slice. It belongs to the [3D Printing Toolbox](../plugins/print-toolbox.md) plugin, which is on by default, and you find it under Print on the rail.

Select the bodies you care about, or select nothing to check all of them, and pick Printability. A panel opens with the settings the check needs. Nozzle and Layer are your printer's values and start at 0.4 mm and 0.2 mm. Overhang angle, Smallest gap and Longest bridge say how strict to be. Up is the direction the part will be printed in, or you can tick Lay flat on the largest flat face and let it choose.

Five kinds of problem can be switched on or off: Overhangs, Thin walls, Gaps, Bridges and Open shells. Gaps are places where two surfaces are so close they would fuse into one. Open shells are bodies that are not fully closed, which can confuse a slicer.

<!-- shot: printability-panel | The Printability panel with a few findings listed and the matching faces tinted in the viewport -->

Press Check. The findings are listed under each body, and the faces involved are tinted in the view, one colour per kind of problem. Hover a line to pick out its face, and click it to turn the view toward it. If you change the model afterwards the panel says so, and you run the check again.

The check is a guide and not a promise. Your slicer and your printer have the last word, so use the list to find the spots worth a second look.

## Bed Fit Check

Bed Fit Check, also under Print, answers one question: does this part fit on my printer. Pick it and choose your bed size from the list, which runs from 180 mm cubed to 350 mm cubed, or choose Custom and type the width, depth and height. FundaCAD remembers the choice for next time.

The answer is a short message. If the part fits, it says so and shows the size of the part. If it does not, it tells you what percentage you would have to scale the part to. It works from the overall size of the part, so it does not know whether turning the part diagonally on the bed would help.
