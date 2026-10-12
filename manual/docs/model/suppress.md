# Reorder and suppress

Steps can be dragged to a new place, switched off, or made conditional.

<!-- shot: suppress-step | greyed step with right-click menu -->

A step can only use things made before it, so moving a fillet ahead of its extrude turns it red. Drag it back or press Ctrl+Z.

Suppress turns a step off without deleting it, which is a safe way to test whether a fillet is causing trouble. Add condition gives a step an Active when row, such as `thick > 2`, and it runs only while that is not zero.

If an early change leaves a later step unsure which face it used, its menu gains Re-pick face.
