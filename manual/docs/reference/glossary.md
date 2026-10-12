# Glossary

The words this manual uses, grouped by what they are about and in alphabetical order
within a group.

## Files and formats

**.funda.** FundaCAD's own document. It is readable text and keeps your sketches, features,
parameters and history, so you can reopen it and carry on editing.

**.fundab.** The same document stored as a smaller binary file. Save As offers both.

**3MF.** A triangle-mesh format that slicers open, offered next to STL in the Export window.

**Branch.** A separate line of versions inside one document. You branch off a version to try
something without losing the line you were on.

**GLB.** A binary 3D file (glTF) that viewers and web pages understand. The Export window
offers it as a fourth type.

**Linked document.** A document inserted with Insert Document in link mode. FundaCAD
remembers the file it came from and can tell you when that file has changed.

**Mesh.** A surface made of many small triangles. STL, 3MF and GLB files are meshes, and
Import Mesh can bring one into a document.

**Recent files.** The list of documents you opened lately, shown in the welcome window.

**Recovery.** The automatic safety copy FundaCAD writes while a document has unsaved
changes. If the app dies before you save, the copy is offered back at the next start.

**STEP.** A file format that stores the exact solid instead of triangles, which makes it the
way to hand a part to other CAD programs.

**STL.** The triangle-mesh format almost every slicer reads. It is the default in the Export
window.

**Version.** A saved snapshot of the document with a short message, which you can compare
with and return to.

## Modelling

**Body.** One solid shape in your model. A document can hold many bodies, and each one has a
row in the Items card.

**Boolean.** Combining bodies. Union merges two into one, Subtract removes one from another,
and Intersect keeps only the part they share.

**Configuration.** A named set of parameter values, for example one for a small version of a
part and one for a large version. The Extra Parameters plugin provides them.

**Cut.** An extrude or revolve that removes material from an existing body instead of adding
to it.

**Feature.** One step in building a part, such as a sketch, an extrude or a fillet. Every
feature is a step in the History, and this manual mostly calls it a step.

**Folder.** A group of bodies in the Items card, which FundaCAD calls an element. Selecting
a folder selects everything inside it.

**History.** The list of steps in the order they are built, also called the timeline.
Click a step to see and change its values.

**Items.** The card that lists everything in the document, with an eye on each row to show
or hide it.

**Join.** An extrude or revolve that adds material to a body that is already there.

**Parameter.** A named number, like a wall thickness, that features can use. Change it once
and everything that uses it is rebuilt.

**Primitive.** A ready-made box, cylinder, cone, sphere or torus.

**Rollback.** Dragging the marker in the History back to an earlier step, to see the model
as it was then.

**Suppress.** Switching a step off without deleting it. Unsuppress turns it back on.

**Target.** The body a join, cut or intersect acts on. Naming it keeps the operation from
touching other bodies it happens to overlap.

## Sketching

**Constraint.** A rule that a sketch keeps true, such as two lines being parallel or a curve
being tangent to another.

**Datum axis, datum plane, datum point.** Reference geometry you add yourself, to sketch on
or to measure from.

**Dimension.** A constraint with a number, such as a length or a diameter. A reference
dimension only shows a measurement and does not control anything.

**Entity.** A single piece of a sketch, such as one line, circle or arc.

**Offset plane.** A plane that sits parallel to another plane or a flat face, at a distance
you choose.

**Origin.** The point where the three axes meet.

**Profile.** A closed outline in a sketch. Extrude, revolve and the other shape tools work
from profiles.

**Sketch.** A flat drawing on a plane or a face. It is the starting point for most solids.

**Snap.** A setting in the sketch palette that makes the cursor jump to nearby points and
to the grid while you draw.

## Shapes

**Chamfer.** A flat bevel cut along an edge.

**Draft.** A small tilt added to a face so that it leans away from a chosen direction.

**Edge.** The line where two faces meet.

**Extrude.** Pushing a profile out into a solid, in a straight line.

**Face.** One surface of a body, flat or curved.

**Fillet.** A rounded edge.

**Loft.** A shape that blends from one sketch to another, or through several.

**Mirror.** A copy of a body reflected across a plane.

**Pattern.** Repeated copies, either in a line (linear) or around an axis (circular).

**Press/Pull.** Moving a face in or out. The body grows or shrinks with it.

**Revolve.** Spinning a profile around an axis, which is how you make a vase or a wheel.

**Shell.** Hollowing a body out to a given wall thickness, optionally leaving one or more
faces open.

**Split Body.** Cutting one body into pieces with a plane.

**Sweep.** Pulling a profile along a path.

**Taper.** A lean on the side walls of an extrude, set with the side handle on the arrow.

**Thicken.** Giving a face a wall of its own, with a thickness you choose.

**Vertex.** A corner point of a body.

## Assemblies

**Interference.** Where two bodies overlap. The Interference tool finds it.

**Joint.** A rule that places one body against another, face to face, with an optional
slide and turn.

**Mechanism.** A set of joints between bodies, with one body held fixed, so you can drive a
linkage with a single value.

## Inspecting

**Curvature.** A view that draws small combs along the edges, longer where the curve bends
harder.

**Overhang.** A view that colours the faces which lean too far over to print without
support, for a build direction and angle that you choose.

**Section.** A view that cuts the model open with a plane, so you can see inside it.

**Stress.** An analysis of one body. You mark where it is held and where it is loaded, and
it shows where the material is strained and how much the part bends.

**Zebra.** A view that lays stripes over the surface. Where the stripes break or bunch up,
the surface has a kink.

## Render

**Bloom.** A soft halo around bright areas of the picture. It is an effect on the image and
does not light up other objects.

**Glow.** The material setting that makes a body or a face give off light, which also falls
on the parts next to it.

**Material.** The finish of a body in the Render workspace, such as glass or brushed metal.

**Node editor.** The graph in the Render workspace where you build a surface finish by
connecting patterns like noise, scratches and bands.

**Workspace.** One of the two modes of the window, Model and Render. A switch in the title
bar moves between them.

## Plugins and AI

**Funda Engine.** The part of FundaCAD that works out the shapes.

**Grant.** A permission a plugin asks for, such as reading the document. Preferences,
Plugins lists each one in a plain sentence.

**MCP.** The connection that lets an AI assistant build and inspect parts in FundaCAD. It is
built in, and setup is in Preferences.

**Plugin.** An optional add-on that brings extra tools to the app, such as the screws
library or the texture tool.

## Viewport and input

**Command palette.** A search box for every command in the app. Press Ctrl+K.

**Gizmo.** The handles shown on a body or sketch while you move and turn it.

**Wireframe.** Showing only the edges of the model. Shift+X toggles it.

**X-ray.** Seeing through the model so you can select what is behind. X toggles it.
