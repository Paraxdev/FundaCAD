# Creating bodies

Solids come from the Create tools on the rail. Most of the time that means drawing a sketch and extruding it, but you can also spin a profile around an axis, blend between two profiles, push a profile along a path, or start from a ready-made shape like a box.

Each of these adds one step to the History, and the step keeps its settings, so you can come back and change a depth or an angle later.

## Sketch and Extrude

Sketch (S) opens a drawing on a plane or on a flat face, and the [sketch pages](../sketch/drawing.md) cover it in detail. What matters here is that the closed shapes in a sketch become profiles, and every tool on this page starts from a profile. After you leave a sketch its profiles stay clickable in the view.

Extrude (E) pulls a profile into a solid. Click the profile, drag the arrow away from the sketch, and click to finish. You can also type the depth as soon as the arrow appears and press Enter. A flat circle becomes a cylinder, and a rectangle becomes a block.

A sketch with several closed areas lets you pick more than one. Ctrl-click adds another area, and Enter moves on to the depth. An outline with a hole inside it, such as a washer, extrudes with the hole left open.

Dragging into existing material cuts, and dragging away from it adds. A rectangle drawn on top of a block and pulled up becomes a boss, while the same rectangle pushed down becomes a pocket. If there is no body yet, the result is a new body. The Operation row of the step can change the outcome afterwards, to New body, Join, Cut or Intersect.

<!-- shot: extrude-taper | extruding a rectangle with the taper handle pulled in on one side -->

Alt+S makes the extrude symmetric, so it grows by the same depth on both sides of the sketch plane. That is a quick way to build something centred on its sketch. A handle on the side of the arrow adds a taper, and you can type the angle too. A positive taper narrows the far end, so a tapered circle turns into the stump of a cone. The largest taper is 88 degrees.

If a flat face of a body is selected when you press E, Extrude acts as Press/Pull on that face. The one exception is a face that lies under a visible sketch, where the sketch's profile gets the extrude.

## Primitive

Primitive offers five ready-made solids: Box, Cylinder, Cone, Sphere and Torus. Pick one and it appears centred on the origin, with sizes you can change in the value rows of its step.

Primitives are useful when a part is mostly boxes and rods, and as cutting tools. Put a cylinder where a hole should go, then use Subtract to take it out of the block.

## Revolve

Revolve spins a profile around an axis, which is how you make bottles, knobs, pulleys and anything else that is round when seen from above. The sketch for it is usually half the outline of the finished part, drawn on one side of the axis.

Choose Revolve, click the profile, and then click what to spin around. That can be one of the three axis arrows at the origin or a straight edge on the model. If a datum axis is selected before you start, Revolve uses it without asking. A full turn is the default, and the Angle row of the step changes it.

## Loft

Loft blends from one profile to another. Draw two sketches on different planes, for example a circle on one and a square on a plane above it. Choose Loft, click the first profile and then the second, and press Enter. That pair gives you an adapter from a round pipe to a square one.

Clicking a profile again drops it from the loft. A loft needs at least two profiles, and the tool says so if you press Enter with fewer.

## Sweep

Sweep pushes a closed profile along a path. It needs two sketches, one with the closed profile and one with an open curve for the path. Choose Sweep and click the profile, and if there are several possible paths, pick one from the list.

For a clean result, draw the profile at the start of the path and roughly square to it. If there is no second sketch, the tool tells you to add one.
