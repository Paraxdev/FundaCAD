# Node Bodies

Node Bodies makes soft, rounded shapes such as a handle, a grip or a toy limb. You place sized points and FundaCAD joins them into one smooth solid. It is on by default, under Create on the rail.

<!-- shot: node-body-limb | bent limb of four nodes with gizmo -->

A node is a point with three radii, Radius X, Y and Z, so it can be a ball or a stretched egg. A chain of nodes becomes a limb with a rounded cap.

## Making a node body

1. Pick Node Body and click in the view to place the first node.
2. Click again to add nodes. With Link new nodes to the picked one ticked, each click extends the chain.
3. Click a node to move, turn or resize it with the gizmo.
4. Press Enter or Add to add the body. Esc leaves without it.

While the tool is open:

- Alt-drag a node to pull a linked one out of it.
- Shift-click a node to link it to the picked one.
- Del removes the picked node.

## Settings

- **Blend**: above 0, rounds the joints where limbs meet.
- **Operation**: New body, or Join, Cut or Intersect with a body you have.

Each position, radius and turn is a value in the History card, so a parameter can drive it.
