# Picking in the view

A click picks a body, and a second click on it picks the face or edge under the cursor. Resting the pointer on a body lights up the face first.

<!-- shot: picking-face | top face of a block highlighted under the pointer -->

## Pick modes

| Key | Picks |
| --- | --- |
| 1 | Faces only. |
| 2 | Bodies only. |
| 3 | A body, then its faces. This is the default. |

The same choice is under Select, in the Appearance tab of the Views button.

## Seeing through

1. X sees through the model, so you can pick what is behind.
2. Shift+X shows edges only.

## Box select

1. Drag to the right to take what lies fully inside the box.
2. Drag to the left to take anything it touches.
3. Hold Shift to add to the selection.
4. Press Tab while dragging to take everything, faces, sketch profiles, edges or bodies.

## Pick with keys

These keys are one way to pick, among clicking in the view and the [Geometry tab](items.md#the-geometry-tab). Tab or F6 moves focus to the 3D view, and a focus ring shows it is there.

| Key | What it does |
| --- | --- |
| `]`, `[` | Step to the next or previous row and light it. The name is spoken, and nothing is selected yet. |
| Shift+`]`, Shift+`[` | Switch what the brackets step through: Faces, Edges or Planes. |
| Enter | Select the lit row only. On a lit plane, start a sketch. While a tool waits for a pick, give it the lit row. |
| Space | Add or remove the lit row. While a tool waits for a pick, give it the lit row. |
| Esc | Put the light out and clear the selection. |

The brackets walk the Geometry tab's list, with its body and its filters, and wrap at the ends. The readout shows the lit row until the light goes out, with a tool waiting too, and moving the pointer over the view puts it out. A tool that is waiting for a face, edge or plane takes the brackets too, and Enter or Space then gives it the lit row, which puts the light out. What it took is spoken, and a refusal is spoken with the kinds it takes. While a sketch is open, a choice menu is up, or a tool is open that takes no rows, these keys do nothing.

They work with Single key shortcuts off, as long as focus is on the 3D view. With it on, they also work when focus is nowhere in particular, say after a click or a finished tool.

### Commands

Next Face, Previous Face, Next Edge and Previous Edge select the row straight away and speak it. They are in the Edit menu and the command palette. They have no key until you [give them one](../reference/shortcuts.md#change-a-key).

### Pick first, then start the tool

Fillet, Chamfer, Press/Pull, Shell, Offset Face, Draft, Hole, Thread and Sketch take what is selected when they start. Stress takes it with Use selected faces.

To fillet two edges:

1. Press Shift+`]` until you hear Edges.
2. Step to the first edge and press Enter.
3. Step to the second edge and press Space.
4. Press F, type a radius and press Enter.

You can also start the tool first. Press F, press F6 to reach the 3D view, step to an edge and press Enter. You hear the edge's name and "added", and the radius box takes the focus, so type a radius there. Press F6 to return to the 3D view and step to another edge, and press Enter to add it. Stepping to an edge that is already in and pressing Enter takes it out, and you hear "taken out". With Include Tangent Edges on, an edge that runs smoothly into others brings them along, and you hear how many edges that made. When the edges are right, press Enter on the 3D view to apply.

To sketch on a face, step to it, press Enter, then S. To sketch on a plane, press Shift+`]` until you hear Planes, step to it and press Enter. With Single key shortcuts off, start the tool from the command palette.

A tool started with nothing picked takes a row too, so you can start it first and then step to the face and press Enter. A running Fillet takes more edges the same way: step to an edge and press Enter to add it, or to take it out again if it is already in.

### What still needs a pointer

1. Vertices are not listed and cannot be stepped to.
2. A tool that is already running takes a face or an edge from the brackets or the Geometry tab's list, see [the list of what each takes](items.md#the-geometry-tab). A click in the view is still needed for a round face's tangent plane, a Stress spot, a Hole's next positions, one profile out of several for Revolve or Sweep, and the view cube's Set from face, which is on its right click menu only.
3. Stepping follows the list. There is no step to the face next door, and no way to walk by size.
4. The view does not turn to a stepped face, and a face behind another shows no light. Its name is still spoken and shown on the readout, and [X](#seeing-through) sees through to it.

These keys have not been tried yet with a screen reader. In browse mode a screen reader may keep the brackets for itself.

## The view as text

To a screen reader the 3D view is a picture named Model. Its description says how many bodies and features there are, which view you look from, whether Section is on and what is selected. It is brought up to date after each build, pick and view change, so moving focus to the view reads it again.

Ctrl+1 to Ctrl+7 turn to the Front, Back, Left, Right, Top, Bottom and Isometric views. After one of them, an arrow key turn, Reset camera or a view cube click, the screen reader hears where the model is seen from: the view by name, or the nearest side with how far the view is turned and tilted, and whether it is orthographic or perspective.

Describe Model, in the View menu and the command palette, opens a dialog with headings for Overview, Bodies, Features and View. Each body has its size, the center of its box and its volume. Sizes are X by Y by Z in your units, and Z points up. Copy as text puts the same text on the clipboard. Describe Selection says what is selected, with its size and center. Neither has a key until you [give them one](../reference/shortcuts.md#change-a-key).

With VoiceOver on a Mac, Quick Nav is a quick way through the view and the dialog. Press Left Arrow and Right Arrow together to turn Quick Nav on. Then G moves to the next graphic, the 3D view, and VoiceOver reads its name and description. In the Describe Model dialog, H moves to the next heading and L to the next list, and the arrow keys read one body at a time. Turn Quick Nav off the same way before you type a value. Single key Quick Nav has to be on for G, H and L, VoiceOver Utility has the switch. These steps have not been tried yet with a screen reader.

## Delete a face

Select a face and press Delete. The face goes and the solid heals over the hole, even on an imported model.
