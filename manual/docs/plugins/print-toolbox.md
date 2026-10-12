# 3D Printing Toolbox

Some shapes are hard to print. A round hole that runs sideways has a ceiling that sags, a first layer squashes out at the bottom edge, and a screw hole in plastic never has a thread. This plugin collects the usual fixes as tools, so you shape the part for the printer without remodelling it by hand.

It is on by default. The tools are under Print on the rail, next to the two checks described on the [Print checks](../inspect/print-checks.md) page.

## Using a tool

Most of the tools work on faces. Say you have a bracket with a horizontal hole for a rod. Select the inside face of the hole and pick Teardrop, and the round hole turns into a teardrop with a pointed roof that prints without support. If you pick the tool first, it waits for you to click the faces and press Enter.

<!-- shot: teardrop-hole | A sideways hole before and after Teardrop, with the step in the History -->

Each tool adds a step to the History, built as exact geometry. A fillet or a cut you add afterwards sees the reshaped hole, the export contains it, and every value can be changed later in the rows of the step. The build direction a step records is the one you had set in Overhang when you made it, which is +Z unless you changed it.

## Holes and bridges

Teardrop turns a sideways round hole into a teardrop. Roof angle sets how steeply the top leans, and Roof can be Pointed or Flat. Roof Bridge squares off the top half of a sideways hole, so the ceiling is one flat bridge. For both, pick the inside face of each hole.

Counterbore Bridge is for a counterbore, the wide recess a screw head sits in. Its ceiling is hard to print, so the tool cuts one layer to a slot as wide as the bore, the next to a square, and optionally a third to an octagon, and each layer bridges over the last. Pick the flat floor of each counterbore.

Sacrificial Layer closes a hole with a thin membrane that the slicer bridges over, and you drill it out after printing. It is the old trick for a hole that would otherwise need support inside it. Pick the inside face of a hole, or the flat face it opens onto, and choose whether to close the Top or the Bottom end.

## Threads and zip ties

Thread-Forming Ribs puts thin ribs on the inside of a round hole, so a screw cuts its own thread into the plastic as it goes in. Pick the inside face of each hole.

Zip-Tie Channel cuts a U-shaped channel under a flat face, so a zip tie can loop through the part. Pick the face to cut under. It refuses a channel that would break through the far side, unless you turn on Allow breakthrough in its rows.

## Edges

Elephant-Foot Chamfer and Vertical Edge Fillet work on whole bodies. They act on the bodies you have selected, or on the active body if nothing is selected, as soon as you pick them.

Elephant-Foot Chamfer chamfers the outer edges of the bottom face, which cancels the way the first layer squashes outwards. Vertical Edge Fillet rounds every edge that runs straight up, and Convex edges only limits it to the outside corners.

An edge that cannot take the chamfer or fillet is skipped, and the rest are still done. The tooltip of the row tells you how many were skipped, and the step only fails if none of the edges worked.

## If you switch it off

The file still opens and every value is kept, but these steps stop building. The holes build in their plain shape, and each step says by name that this plugin is not running. Switch the plugin back on and the same file builds as before.
