# Measure and section

Before you print a part you usually want a few answers. How far apart are these two holes, what does it look like inside, how much plastic will it eat, do the two halves collide. The Inspect tools on the rail answer those questions without changing the model.

## Measure

Measure gives you a length, an area, a distance or an angle from things you click on. You would reach for it to check a wall thickness, a gap between two parts, or whether a hole sits where you meant it to.

Press I, or pick Measure under Inspect. Click a face or an edge, and a small panel shows its area or its length. Click a second one and the panel switches to the pair: the shortest distance between them, that distance split into X, Y and Z, the distance between their centres, and the angle between them.

<!-- shot: measure-two-holes | Measure panel open after clicking the edges of two holes, showing Distance and the X Y Z split -->

A third click throws the first two away and starts a new measurement, and Esc leaves the tool. You can also start from a right-click: choose Measure from here on a face or edge, and it is already picked when the tool opens.

The numbers follow the unit you chose in Preferences. On flat faces and straight edges they are exact. On curved faces the distance is worked out from the displayed mesh, so it can be off by a tiny amount.

## Section

Section cuts the model open with a plane so you can see inside. It is the quick way to check a wall thickness, a hollow, or what a hole does on its way through a part.

Pick Section under Inspect, and FundaCAD asks what to cut along. Face or plane lets you click a face on the model or a datum plane. Z, X and Y cut along that axis with no aiming at all, and Z gives a horizontal slice, which is probably the one you want first.

<!-- shot: section-handle | A bracket cut along Z with the drag handle on the plane and the removed half shown as a faint ghost -->

Drag the handle on the cut plane to move the cut through the part, or type a distance and press Enter. F flips which half is kept. The half that is cut away stays as a faint ghost, so you can still see where the rest sits, and G steps through how strongly it is drawn, from hidden to strong.

Section stays on while you work. You can orbit, select things, or fillet an edge you exposed a moment ago, and the cut is still there. Pick Section again, or press Esc, to leave it.

## Properties

Properties shows the volume, the surface area, the centre of mass and the bounding box. It works on the bodies you have selected, or on every body when nothing is selected, and its title tells you which. It is under Inspect.

Below those numbers is a small print estimate. Pick a material (PLA, PETG, ABS, ASA, TPU or Nylon, or Custom to type a density), an infill percentage and a wall thickness. You get a mass in grams and the length of filament that is, for 1.75 mm and 2.85 mm spools.

The estimate is the shell plus the infill share of what is inside it, times the density. Treat it as a good guess for comparing two designs, and use your slicer for the real number.

## Interference

Interference finds bodies that overlap, which you want to know about an assembly before you print its parts. It is under Inspect too. The panel lists every pair of bodies that share space, with both names and the size of the overlap, and a click on a row highlights that pair in the view.

Clearance mode looks for the opposite problem, parts that are close enough to fuse or rub. Type a distance and it lists the pairs that come closer than that. The printability check uses 0.2 mm as its smallest gap, so that is a sensible number to try first.
