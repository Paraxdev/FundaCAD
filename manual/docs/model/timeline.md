# History

Every time you sketch, extrude, fillet or drill, FundaCAD adds a step to the History. The History card lists those steps in the order they were made, and the model on screen is what you get by running them from first to last. Because the steps are kept, you can go back to any of them and change it, and everything after it is rebuilt.

That is the difference between a parametric model and a mesh. If you realise the plate should be 4 mm thick and not 3, you do not redo the holes. You open the extrude step, change the number, and the holes follow.

<!-- shot: history-card | the History card with a few steps, one selected with its values open beneath it -->

## Working with a step

Each step is a chip with an icon and a name. A click selects it and opens its values underneath, where you can read or change them. Double-click a step to edit it with its own tool. The model rolls back to the moment before that step while you work, and everything returns when you finish or press Esc.

Right-click a step for the full menu: Edit, Rename, Suppress, Add condition, Roll back before this, Roll to here and Delete. F2 renames the selected step. A short name is easier to find once a part grows past twenty steps, so name the important ones.

A step that failed is drawn in red. Hover over it to read why, and click the red badge in the card header to jump to the next failing step. A step that built but has something to tell you is drawn in amber.

A long history gets hard to read. The small button in the header of the card shows only the steps that relate to your selection, which cuts the list down to the few that touch the body you are looking at.

## Going back in time

The thin marker between the chips is the rollback marker, and everything after it is switched off. Drag it back and the model shows an earlier state, with the later steps greyed out. The four buttons at the top of the card jump to the start, step back one, step forward one, and jump to the end.

Roll back before this puts the marker in front of a step, so you see the model as it was before that step ran. Roll to here puts it right after, so you see what that step produced. It is the quickest way to find out which step introduced a problem. Drag the marker to the end when you are done.

## Reordering and switching off

Steps can be dragged along the card to reorder them. A step can only use things that were made before it, so moving a fillet in front of the extrude that made its edge breaks it. If a step turns red after a move, drag it back or undo with Ctrl+Z.

Suppress turns a step off without deleting it, and the model is rebuilt as if the step were not there. Unsuppress in the same menu brings it back. It is a safe way to test whether a fillet or a hole is causing a problem further down the list.

Add condition goes one step further. It gives the step an Active when row, and the step only runs while the value of that row is not zero. You can type a comparison there, such as `thick > 2`, using the names from the [parameters page](parameters.md).

Sometimes an early change alters the model enough that a later step can no longer tell which face it was attached to. The right-click menu of that step then gains Re-pick face. Choose it, click the right face, and the step is repaired.

## Versions

The History is the list of steps inside one version of your part. Versions are snapshots of the whole document that you save on purpose, like a checkpoint before a risky change. They are covered under [Saving and documents](../files/documents.md#versions).
