# Planes, points and axes

The Construct tools on the rail make reference geometry, which builds no solid. You use it to have somewhere to sketch, something to cut along, or a line to spin or pattern around. The faces of a part rarely sit exactly where the next sketch needs to be, and these tools fill that gap.

Everything you make here shows up in the Items card, planes under Planes and points and axes under Datums. You can rename them, hide them with the eye, and select them to use as a reference.

<!-- shot: construct-planes | a block with an offset plane and a datum axis shown in the viewport and listed under Planes and Datums -->

## Offset Plane

Offset Plane (O) is the one you will use most. It makes a plane a set distance away from an existing plane or face, and then opens a sketch on it. Click a plane or a flat face, drag the arrow or type the distance, and click to finish. A ghost of the new plane shows where it will land.

Say you have a block and want a sketch 8 mm below its top surface. Select the top face, press O, drag the arrow down into the block until the box reads 8 mm, and click. You are now sketching in the middle of the block, ready to cut a pocket from there.

The plane keeps its link to the face, and its distance stays editable in the step, so the sketch moves with it.

## Datum Plane

Datum Plane works like Offset Plane, but it only makes the plane and does not open a sketch. It also has more handles. Besides the offset arrow there are rings that tilt and spin the plane, so you can get a plane at an angle to anything. Shift makes the rings step in finer increments, and Alt lets the angle go free.

Picking a round face gives you the plane that touches it at the spot you clicked. Offsetting that plane moves it straight out from the surface, so a plane 5 mm off a boss is a single gesture.

## Midplane and Plane, 3 Pts

Midplane takes two planes or faces and makes the plane halfway between them, such as the centre of a wall. Click the first plane or face, then the second. It is the plane to mirror or sketch on when a part is symmetric.

Plane, 3 Pts makes a plane through three points on the model. Click three corners, hole centres or edge midpoints. It reaches planes that no face of the part lies in. Three points in a straight line have no single plane through them, and the tool says so.

Both of these stay where they were when you made them. If you later move the faces they came from, the plane does not follow. The other planes in this group do follow their face.

## Datum Point and Datum Axis

Datum Point is a single click on the model, snapped to its corners and edge midpoints. It builds nothing. It exists to be named, measured to and snapped to.

Datum Axis makes a line through two points you click, and Revolve and Circular Pattern can use it. Axis on Edge works from a straight edge of the model, and the axis keeps following that edge when the model changes. Round edges are refused, because only a straight edge has an axis.

Like the midplane, datum points and axes made from clicked points do not follow the geometry they were taken from.
