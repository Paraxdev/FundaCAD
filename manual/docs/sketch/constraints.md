# Constraints and dimensions

A constraint is a rule you attach to your drawing, such as "this line stays horizontal" or "these two circles share a centre". A dimension is a rule with a number in it, such as "this line is 40 mm long". The sketch keeps all of its rules true at once, so changing one size moves everything that depends on it.

That is what makes a sketch worth the trouble. A bracket drawn with the right rules can be made 10 mm wider by changing a single number, and the holes stay centred.

<!-- shot: sketch-constraints | a sketch with dimensions, constraint symbols and the Relations list open -->

## Reading the colours

The colour of a curve tells you how well it is pinned down. Blue curves can still move, because nothing fixes them completely. White curves are fully defined. Red means two rules disagree and the sketch cannot satisfy both.

You do not need everything white to extrude a profile. It does help when you plan to change sizes later, since a fully defined sketch only moves in the ways you asked for.

## Adding a constraint

Some constraints happen on their own. When you finish a line that is within about 3 degrees of horizontal or vertical, FundaCAD assumes you meant it and makes it exactly so. The exception is a line whose two ends both snapped to grid points. That placement is taken as deliberate, and a line one cell off level stays one cell off level.

For the rest, the Constrain button on the rail holds all twelve. Pick one, then click the shapes it needs. The text at the bottom of the view says what comes next, and Esc lets go of the tool.

Most of the names say what they do. Horizontal and Vertical take one line, and Parallel, Perpendicular and Collinear take two. Equal gives two lines the same length, or two circles or arcs the same radius. Tangent takes two curves, Concentric takes two circles or arcs, and Coincident joins two endpoints into one point.

Three of them need a little more. Midpoint takes a point and then a line, and puts the point in the middle of the line. Symmetric takes two endpoints and then an axis line, and keeps the points mirrored across it. Fix locks a point or a circle centre where it is, which is how you anchor a sketch in place.

You can also skip the tool. Select one or two shapes and right-click, and the menu lists only the constraints that make sense for that selection.

## Dimensions

Dimension (D) is the tool for numbers. Click a line for its length or a circle for its diameter, type the value and press Enter. Click two things and you get the distance between them. Two lines give the angle between them, or the gap if they are parallel.

On a circle or arc, right-click while the tool is running to switch between Radius and Diameter. The same menu has Pick Circle/Arc Tangent, which measures to the rim of a circle instead of its centre.

To change a dimension later, double-click its number and type the new value. To remove one, right-click it and choose Delete dimension. A dimension also takes the name of a parameter or an expression such as `width / 2`, and its label then reads `fx:` before the value. The [parameters page](../model/parameters.md) explains how that works.

Sometimes you want to read a length without it becoming a rule. Driven (reference) in the right-click menu turns a dimension into a measurement. It is shown in brackets, cannot be edited, and only reports what the other rules already decided. Reference Dim in the sketch palette makes every new dimension driven until you switch it off again.

## Seeing what holds the sketch

The Relations list at the bottom of the sketch palette shows every rule in the sketch, one row each. Hover a row to see where it applies, and click it to select those shapes. The small x on a row deletes that constraint.

Rows marked implied are not rules you added. They exist because two endpoints sit on the same point, and there is nothing to delete. A row marked Conflicting is the one to look at when a curve turns red, and Redundant means something else already says the same thing.

If a new rule turns the sketch red, undo it with Ctrl+Z or delete the conflicting row. The usual cause is two rules that fight each other, such as a line that must be 30 mm long and also equal to another line fixed at 20 mm.
