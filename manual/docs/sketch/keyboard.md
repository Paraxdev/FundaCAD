# Draw with keys

Line, Rectangle and Circle can be drawn from start to finish with the keyboard, with no click. It is one way to draw among others, and the mouse works as it always did.

Each point is spoken as you place it, such as "Point at 20, 10, snapped to the midpoint of Line 2", and a finished shape is spoken with its size.

## Start a sketch

1. Press F6 until focus is on the Items panel, then Tab to the Items tree.
2. Arrow to XY plane, or another plane, and press Enter. The sketch opens.
3. Press L, R or C for Line, Rectangle or Circle.

With Single key shortcuts turned off in Preferences, the letters and digits do nothing on their own. Pick the tool in the command palette (Ctrl+K), and use Enter or Shift+Enter to open the X and Y boxes.

## Keys with a draw tool armed

| Key | What it does |
| --- | --- |
| Enter | Opens the X and Y boxes for the first point |
| A digit, `-`, `.` or `@` | Opens the same boxes with that character already typed in X |
| Shift+Enter | Opens the boxes at any time, also after the cursor has moved |
| Arrows | Move the keyboard cursor one grid step. Up is +Y and Right is +X on the sketch plane |
| Shift+arrows, Alt+arrows | Move one step finer, one step coarser |
| Enter, after arrows | Places the point at the cursor |
| Tab, Shift+Tab, after arrows | Next and previous of the 16 snap candidates nearest the cursor, nearest first. The last stop is back where the cursor was |
| Esc | Drops what is half drawn, then arms Select, then closes the sketch |

Arrows turn the view as usual in every other tool, and when the sketch plane is edge-on to the view.

The grid step follows the zoom. It is spoken when it changes, and a typed point never depends on it.

## Type a point

The X and Y boxes take absolute positions on the sketch plane.

1. Press R, then type `5`, Tab, `-7` and press Enter. The first corner is at 5, -7.
2. Type `40`, Tab, `20` and press Enter. The rectangle is 40 wide and 20 high.

A number can also be relative to the last point you placed.

| Type | It means |
| --- | --- |
| X `20`, Y `10` | The point at 20, 10 |
| X `20,10`, Y left alone | The same pair in one box |
| X `@5,3` | 5 along X and 3 along Y from the last point |
| X `@5` | 5 along X, same Y as the last point |
| X `@5`, Y `@-3` | Each box is relative on its own axis |

The comma splits a pair only while Y is empty. With Y typed, a lone comma is a decimal comma, as in every other box. Write `1,5;2,5` with a semicolon for a pair with decimal commas.

After the first point, the box of [exact sizes](exact-sizes.md) takes over: W and H, Diameter, or L and Angle. Type a number, Tab, a number and Enter, or press an arrow and Enter to place the end where the cursor is.

Typing `@` as the first character of a size box turns it back into X and Y for that point. A line chain is then `@40,0` Enter, `@0,20` Enter, and so on. It closes when an end meets the start.

## Change a size by keys

Tab to **Dimensions** in the sketch palette, then to the row of the size, such as "Width of Rectangle 1". Type the new value and press Enter. The sketch updates and focus stays on the row. See [Dimensions](dimensions.md).

## Snaps

Press arrows to move the cursor, then Tab. Each press names a snap near the cursor and moves the cursor onto it, such as "Cursor at 20, 5, snapped to the midpoint of Line 2". Enter places the point there, with the snap kept, as a click on a snap would. After the last candidate, Tab says "No snap, cursor at 20, minus 20" and the cursor is back where it was. If that spot is itself a snap, Tab says "End of nearest snaps, cursor at 20, minus 20, snapped to the end of Line 2". Tab walks the 16 candidates nearest the cursor, to reach a farther one, move the cursor closer with arrows and press Tab again, or type its coordinates. With no candidate, Tab moves focus as usual. See [Snapping](snapping.md).

## A plate with a hole

1. Open a sketch on the XY plane as above.
2. Press R. Type `5`, Tab, `-7`, Enter. Type `40`, Tab, `20`, Enter.
3. Press C. Type `25`, Tab, `3`, Enter. Type `10`, Enter. The circle is 10 across and sits inside the rectangle.
4. Press E for [Extrude](../model/extrude.md). Tab walks the closed profiles and speaks each one, such as "Profile 1 of 2, 1 hole". Stop on the one with the hole and press Enter.
5. Type `8` and press Enter. The plate is 8 mm thick, with the hole through it.

## What is spoken

1. A placed point: "Point at 5, minus 7". A snap adds "snapped to the midpoint of Line 2".
2. A finished shape: "Rectangle 1, 40 by 20", "Circle 1, diameter 10" or "Line 4, length 20, loop closed". A typed angle is said too, "Line 1, length 25, angle 30 degrees". A line's chain goes on, so its keys follow, "Type the size, or @dx,dy, arrows move, Enter, Esc".
3. An arrow: "Cursor at 20, 10". When the grid step changed, "Grid step 5 mm" comes first.
4. A refused entry: the problem, and the box is marked as any refused box is.
5. A change in how free the sketch is, such as "1 degree of freedom" or "Fully defined". Conflicting rules are said as an alert. Opening a sketch says nothing.

Values are said in the display unit. See [Shortcuts](../reference/shortcuts.md) for every key.
