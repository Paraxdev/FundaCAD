# Bodies and the Items card

A body is one solid piece of your model. A cup is one body, and a lid next to it is another. Most of what you do in FundaCAD acts on bodies and on the faces and edges that belong to them, so it helps to know how to pick, hide and organise them.

## The Items card

The Items card lists everything in the document, in sections: Origin with the three base planes, then Bodies and Sketches. Planes, Datums, Joints and Mechanisms get a section of their own once you have made one. The drop-down at the top narrows the list to All items, Bodies, Planes and axes, or Sketches.

<!-- shot: items-list | the Items card with a few bodies, a folder and a sketch, one body hidden -->

A click on a row selects it, Ctrl+click adds to the selection, and Shift+click takes everything from the last row you clicked to this one. Double-click a body to rename it, or a sketch to edit it. A right-click on a body offers Move to, Material, Visibility, Rename and Delete.

While a tool is waiting for a pick, a click on a row can answer it when the row is the kind of thing the tool wants. When it is not, the prompt tells you to pick in the view.

You can close the card with the x in its corner and bring it back with the Items button at the edge of the viewport, or with Ctrl+Alt+S.

## Hiding and showing

Each row has an eye. Click it to hide the body or sketch, and click it again to bring it back. Drag across several eyes to hide or show a whole run in one sweep. Alt+click an eye to show only that one and hide everything else of its kind.

From the keyboard, H hides the selected bodies and Shift+H shows them all again. The More button at the bottom of the card has the same two, plus Invert Body Visibility.

Hiding a body does more than clear the view. A body that is hidden when you extrude, join, cut or intersect is left out of that step, as if it were not there, unless the step names it as a target. That helps when a cut would otherwise reach a part you did not mean. It is also worth remembering when a cut seems to do nothing to a body you cannot see.

## Folders

Bodies can be grouped into folders, which FundaCAD calls elements. Right-click the Bodies heading and choose New element, then drag bodies onto it. A folder can be renamed, deleted, moved into another folder, or hidden as a whole with its eye. Dropping a body on the Bodies heading takes it out of its folder again.

Selecting a folder selects every body inside it, so one Move or one Material change acts on all of them. Bodies from an imported assembly arrive grouped the way the assembly was built.

## Picking in the viewport

A plain click picks a body. Click the same body again and you pick the face under the cursor. If you rest the pointer over a body for a moment, the face lights up first and a click takes it directly. These keys change what a click picks.

| Key | What it does |
| --- | --- |
| 1 | Click picks faces directly |
| 2 | Click picks whole bodies only |
| 3 | Click picks a body first, then its faces, which is the default |
| X | See through the model so you can pick what is behind it |
| Shift+X | Show edges only, as a wireframe |

Dragging a box in empty space selects several things at once. Dragging to the right takes what lies fully inside the box, and dragging to the left takes anything the box touches. Hold Shift to add to the selection. While the box is open, Tab cycles between taking everything, only faces, or only edges.

Esc clears the selection. Delete removes a selected face and heals the hole it leaves, which works even on an imported model with no history. To remove a whole body, right-click its row and choose Delete.

A body's colour and finish come from its material. Material in the right-click menu assigns one from the library, and the [materials page](../render/materials.md) explains how to make your own.
