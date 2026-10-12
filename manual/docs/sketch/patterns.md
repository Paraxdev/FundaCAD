# Sketch patterns

When a sketch needs the same shape several times, such as a row of screw holes or a ring of vent slots, draw it once and let a pattern repeat it. The copies stay tied to the original, so changing the original changes all of them.

The Pattern button on the rail holds six of them. Two repeat shapes you drew, and four make holes for you. To repeat finished bodies instead, see Linear Pattern and Circular Pattern on the [modify page](../model/modify.md).

## Repeating something you drew

Rect Pattern lays copies out in a grid, and Circular Pat. spaces them around a centre point. Both start the same way: choose the tool and click the curves you want to repeat. Clicking inside a closed shape takes the curves around it, and clicking a picked curve again lets it go. You can also select the shapes first and then choose the tool.

For a rectangular pattern, click where the pattern should start and move the mouse. How far and which way you move sets the spacing between copies. The boxes next to the cursor hold the count in each direction, Nx and Ny, and you can type into them. A single row follows the mouse, so it can run at any angle, and holding Alt stops the angle snapping to neat values. Click again to place it.

For a circular pattern, a dot marks the centre. If you selected the shapes first it starts in the middle of the selection, and you can drag it to the real centre. Move the mouse around it to sweep out how far the copies reach, and type N for the number of copies and Angle for the total sweep. It starts at six copies over 360 degrees, which spaces them evenly all the way round.

The original counts as one of the copies in both patterns, so a count of 3 gives the original plus two more.

## Making holes

The other four patterns draw the circles themselves, so there is nothing to select first. Click where the middle should be, move the mouse to set the size, type the counts, and click again.

<!-- shot: sketch-pattern | a bolt circle pattern being placed, with the count and diameter boxes visible -->

Bolt Circle places holes evenly around a circle. The mouse sets the diameter of the circle they sit on, N is the number of holes, and Diameter is the size of each hole. It offers 6 holes of 6 mm until you type something else.

Grid Holes makes a rectangular array, with Nx and Ny for the counts, Diameter for the hole size, and the mouse for the spacing. Hex Holes packs the holes in a hexagonal arrangement around the centre, which fits more of them into the same area. Its Rings box sets how many rows surround the centre hole, so 0 gives a single hole. Honeycomb uses the same layout with six-sided cells in place of circles.

## What a copy is not

The copies are made from the pattern's settings and are not separate shapes. You cannot select one of them, snap to it or dimension it. If one copy needs to be different, draw that one by hand.

While you are still placing a pattern, Delete throws it away and Esc keeps it at the values it has reached. Extrude sees the copies as part of the sketch, so a pattern of holes inside a plate cuts all of them in one go.
