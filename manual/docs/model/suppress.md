# Reorder and suppress

Steps can be dragged to a new place, switched off, or made conditional.

<!-- shot: suppress-step | greyed step with right-click menu -->

## Reorder

Drag a step up or down the History card to move it. A step can only use what was made before it, so a fillet moved above its extrude turns red. Drag it back or press Ctrl+Z.

## Suppress

Suppress on a step's right-click menu turns it off without deleting it. It is a safe way to test whether a fillet causes trouble, and Unsuppress brings it back.

## Conditions

1. Right-click a step and pick Add condition. Sketches have none.
2. An Active when row appears in its values, set to 1.
3. Type an expression there, such as `thick > 2`.

The step runs only while that value is not zero. A switched off step is greyed, and hovering it says why. Remove condition on the menu takes the row away.

## Re-pick face

An early change can leave a later step unsure which face it used. Its menu then gains Re-pick face, so you can click the face again.
