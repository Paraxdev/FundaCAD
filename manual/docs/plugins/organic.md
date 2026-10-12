# Node Bodies

Most of what you model in FundaCAD is made of flat faces, cylinders and fillets. Node Bodies is for the opposite: soft, rounded shapes such as a handle, a toy limb, an ergonomic grip or a cable guide that has to flow from one place to another. You place a few points, give each a size, and FundaCAD joins them into one smooth solid.

The plugin is on by default. Its tool is Node Body, under Create on the rail.

## How it works

A node is a point with a size. The size is three radii, one along each of the node's own axes, so a node can be a ball, a flattened pebble or a stretched egg, and it can be turned. A chain of nodes becomes one smooth limb that passes through every node in order and ends in a rounded cap. Nodes that are not on any chain stay as lone blobs.

All the limbs and blobs are fused into a single solid, and that solid is a normal step in the History. It can start a new body, or join, cut or intersect the bodies around it, which you choose with Operation in the panel.

<!-- shot: node-body-limb | A bent limb made from four nodes with the move gizmo on one node and the Node body panel open -->

## Drawing one

Pick Node Body, then click in the view to place the first node. Where it lands depends on what you clicked. A click on a body puts the node on its surface, and a click on a datum plane puts it on that plane. A click in empty space puts it on the plane that faces you through the picked node, or on the ground if no node is picked.

To draw a limb, make sure Link new nodes to the picked one is ticked in the panel. Each new node then extends the chain from the one you picked, so you draw the limb by clicking along it.

Click an existing node to pick it, and the move gizmo appears on it. Its arrows and squares move the node, its rings turn it, and its cubes resize it along its own axes. Each node also has a Centre, Radius and Turn row in the panel, if you would rather type.

| What you do | What happens |
| --- | --- |
| Click a node | Picks it and shows the gizmo |
| Alt-drag a node | Pulls a linked copy out of it |
| Shift-click a node | Links the picked node to it |
| Delete | Removes the picked node |
| Enter | Adds the body |
| Esc | Leaves without adding it |

## Smoothing and limits

Where limbs meet, Blend rounds the junction. Leave it at 0 for a sharp join and raise it for a softer one. If a particular junction cannot be rounded, the body is kept as it is and the step tells you so.

A chain that doubles back on itself more tightly than its own radius folds through itself, and it is refused. Very sharp bends between two nodes pinch on the inside of the bend. If you hit either, spread the nodes out a little or make the bend wider.

## Parameters

Every position, radius and turn is a row in the step, named like `n3 Radius X`. Any of them can be tied to a [parameter](../model/parameters.md), which lets you resize a whole handle from one number. The link is made to the node itself and not to its place in the list, so deleting another node does not break it.
