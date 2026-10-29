# 3D Printing Toolbox

This plugin collects the usual fixes for shapes that are hard to print, as tools under Print on the rail. It is on by default.

<!-- shot: teardrop-hole | sideways hole before and after Teardrop -->

## Using a tool

1. Select what the tool asks for, for example the inside face of a sideways hole.
2. Pick the tool, for example Teardrop.

You can also pick the tool first, click the faces and press Enter. Each tool adds an ordinary step to the History.

Each step has a Build direction, the way your printer stacks layers. It is taken from Build dir in [Overhang](../inspect/overhang.md), +Z unless you set another there.

## The tools

| Tool | Select | What it does |
| --- | --- | --- |
| Teardrop | the inside face of a sideways hole | gives the hole a pointed roof that prints without support |
| Roof Bridge | the inside face of a sideways hole | squares the top of the hole |
| Counterbore Bridge | the flat floor of a counterbore | layers the ceiling of a screw recess so it bridges |
| Sacrificial Layer | a hole's inside face, or the face it opens onto | closes the hole with a thin layer you drill out after printing |
| Thread-Forming Ribs | the inside face of a screw hole | adds ribs a screw cuts its own thread into |
| Zip-Tie Channel | the face to cut a channel under | cuts a loop for a zip tie |
| Elephant-Foot Chamfer | the body, or its bottom face | chamfers the bottom edge, 0.4 mm, against a squashed first layer |
| Vertical Edge Fillet | the body | rounds the edges that run along the build direction, 2 mm |

[Bed Fit Check](../inspect/bed-fit.md) and [Printability](../inspect/printability.md) come with this plugin too.
