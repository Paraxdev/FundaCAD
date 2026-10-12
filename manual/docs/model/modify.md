# Changing bodies

Once you have a body, the Modify tools on the rail shape it. Most of them work the same way: pick the thing to change, drag the arrow or type a number, and click or press Enter to keep it. Esc leaves without changing anything.

You do not have to open Modify every time. Select a face, an edge or a body, and the rail shows the tools that can act on that selection. Every tool adds one step to the History, so you can reopen it later and change the number.

## Press/Pull

Press/Pull (Q) moves a face in or out. Pick a flat face, drag the arrow, and the body grows or shrinks with it. It is the quickest way to make a wall 2 mm thicker without going back to the sketch.

<!-- shot: presspull-face | a flat face selected with the arrow dragged out and the distance box showing -->

Type a distance if you know it, and a negative number cuts into the body. Ctrl-click adds more faces so they move together. To make the face stop exactly at another face, press T and click the face to stop at.

Faces that run smoothly into the one you move are carried along, and the prompt tells you how many. On a round face, such as the wall of a hole or a boss, Press/Pull resizes it around its axis and you type a radius or a diameter. If you want a hole deeper and not wider, set the Direction row of the step to Along axis.

## Fillet and Chamfer

Fillet (F) rounds an edge and Chamfer (B) cuts it at an angle. Click an edge, drag out, and click to finish, or type the size and press Enter. Selecting a face first treats every edge around it. Tab swaps between fillet and chamfer while the size is on screen, without starting over.

Clicking an edge takes the whole run of edges that flow smoothly from it, since a round cannot stop halfway along a smooth line. Shift-click takes exactly the edge you clicked. If you have zoomed right in on one corner, a plain click also takes only that edge.

The step has more options afterwards. Size Type can be Radius or Chord Length, which sizes the round by the width across it. Continuity can be G1, a plain circular round, or G2, which eases into the faces with no jump in curvature. Chamfer has a Type of Equal Distance or Two-Distance.

When a size is too big for the geometry, the tool refuses it and says so in the prompt. Type a smaller one and carry on.

## Hole

Hole drills holes into a flat face. Click the face where the hole goes, and a small box offers the Size, the Depth, and the X and Y position from the middle of the face. Click the face again to add another hole, and click an existing hole to take it away. Enter finishes all of them at once.

Sizes run from M2 to M10 and give you a hole that is ready for that screw. An M3 hole with a Normal fit comes out at 3.4 mm, for instance. Type `through` as the depth to drill all the way, or a number for a blind hole. The type button in the box cycles between Simple, Counterbore, Countersink and Insert, where Insert sizes the hole for a brass heat-set insert.

The step keeps the choices as rows. Standard can be Clearance, Tap drill or Custom, where Tap drill gives the drill size for cutting a thread into the hole. Fit can be Close, Normal or Loose, and on the small sizes the three differ by a few tenths of a millimetre.

## Move, Scale and Mirror

Move (M) places a body somewhere else. Select the body first, or Move takes the most recent one. A gizmo appears with arrows that slide along an axis, squares that slide in a plane, and rings that turn the body. The centre dot moves the point the rings turn around.

Dragging snaps to round steps, and holding Shift makes the steps finer. You can type into the boxes too. Switch on Copy in the box to leave the original where it is and move a copy. Each drag becomes its own step, so Ctrl+Z undoes one nudge at a time. Move also works on a sketch, if you select the sketch and not a body.

Scale resizes a whole body by a factor you set in the value rows of its step, so 2 doubles every dimension. The X factor, Y factor and Z factor rows override it on one axis, for stretching a part in a single direction.

Mirror makes a reflection of a body and joins it to the original. Select the body, or click it when asked, then choose the plane to mirror across: XY, XZ or YZ. It lets you model half of something symmetric and finish it in one step.

## Linear and Circular Pattern

Linear Pattern repeats a body along a straight line, and Circular Pattern repeats it around an axis. Select the body first. If you select a face that a cut or a join made, such as the wall of a hole, the pattern repeats that cut or join, which is how you get a row of identical holes from a single one. Copies that miss the body are skipped.

For a linear pattern, drag the arrow to set the spacing. For a circular pattern, click an edge or face to turn about, or press C to switch between the origin and the middle of the part. The [ and ] keys change the count in both, and you can type the spacing, the angle and the count into the boxes.

## Union, Subtract and Intersect

These three combine bodies. Union joins two bodies into one, Subtract removes one body from another, and Intersect keeps only the volume where they overlap. Their keys are Ctrl+U, Ctrl+B and Ctrl+I.

Choose the tool with nothing selected, click the body to keep, and then click the body to use on it. For Subtract the order matters, since the first body is the one left standing and the second is the one that goes away. If you select two or more bodies beforehand, the first one you selected is kept and the others are used on it.

## Split Body

Split Body (K) cuts one body into pieces with a plane. It first asks which side to keep: Both, Top or Bottom. Both gives you two bodies. If there is more than one body, it asks which one to split. Then click a plane or a face, and drag the arrow to position the cut.

A plane you made earlier can do the cutting too. Select it and choose Split Body, or right-click the plane in the Items card and pick Cut all bodies.

## Shell, Offset Face and Thicken

Shell hollows a body. Click the faces that should become openings, then drag or type the wall thickness. A mug is a cylinder with its top face shelled to a few millimetres.

Offset Face moves one or more faces along their normals while the body stays closed, and the neighbouring faces stretch to follow. A single round face is resized, and you type a radius or a diameter. It works on flat and cylindrical faces only.

Thicken gives a face a wall of its own. Click the face, then drag or type the thickness, and press S if the wall should grow on both sides of the surface. The Operation row of the step chooses between New body and Join.

## Draft and Thread

Draft tilts a face by an angle, so a wall that stood straight up leans back a little. Click the face, then drag or type the angle, up to 60 degrees. The tilt is measured from the bottom of the body, and the pull direction is Z unless you press X to cycle through X, Y and Z.

Thread adds a real helical thread to a round face, a shank for an external thread or a bore for an internal one. Click the face, then drag to set the length, or type the pitch in the P box and the length in the L box. The prompt shows how many turns that gives, and a thread needs at least one full turn.

## Joint and Mechanism

Joint fits one body to another. Click a face on the body that should move, then the face on the other body that it mates to, and the first body is placed with its face flat against the second. Both faces are remembered, so changing either part carries the joined body along. After placing it, an arrow slides the body along the mate axis and a dial turns it about that axis.

Mechanism builds a linkage of moving parts. It asks for the body that stays fixed, then adds joints one at a time. Each joint is Revolute (a pin), Slider or Rigid, and you click a face or edge on the moving part and then on the part it joins. At the end it asks which joint the drive moves, and you drive it with a handle or a typed value.

Parameters, also under Modify, opens the list of named values that drive the model. It has [its own page](parameters.md).
