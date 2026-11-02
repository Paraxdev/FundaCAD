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
| Enter | Select the lit row only. On a lit plane, start a sketch. |
| Space | Add or remove the lit row. |
| Esc | Put the light out and clear the selection. |

The brackets walk the Geometry tab's list, with its body and its filters, and wrap at the ends. The readout shows the lit row until the light goes out, and moving the pointer over the view puts it out. While a tool or a sketch is open, or a choice menu is up, these keys do nothing.

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

To sketch on a face, step to it, press Enter, then S. To sketch on a plane, press Shift+`]` until you hear Planes, step to it and press Enter. With Single key shortcuts off, start the tool from the command palette.

### What still needs a pointer

1. Vertices are not listed and cannot be stepped to.
2. A tool that is already running takes a face or an edge from the Geometry tab's list, not from the brackets. Mirror's plane from a face, Stress's Click faces, Text on a face and a round face's tangent plane for Sketch still need a click in the view.
3. Stepping follows the list. There is no step to the face next door, and no way to walk by size.
4. The view does not turn to a stepped face, and a face behind another shows no light. Its name is still spoken and shown on the readout, and [X](#seeing-through) sees through to it.

These keys have not been tried yet with a screen reader. In browse mode a screen reader may keep the brackets for itself.

## Delete a face

Select a face and press Delete. The face goes and the solid heals over the hole, even on an imported model.
