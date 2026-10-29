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

- X sees through the model, so you can pick what is behind.
- Shift+X shows edges only.

## Box select

- Drag to the right to take what lies fully inside the box.
- Drag to the left to take anything it touches.
- Hold Shift to add to the selection.
- Press Tab while dragging to take everything, faces, sketch profiles, edges or bodies.

## Delete a face

Select a face and press Delete. The face goes and the solid heals over the hole, even on an imported model.
