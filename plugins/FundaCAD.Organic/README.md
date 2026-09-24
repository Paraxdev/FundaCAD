# Node Bodies

Rounded, organic solids built from sized nodes. Each node is a point with
three radii and a turn; a chain of nodes becomes one smooth limb that runs
through every node in order and ends in a rounded cap. All limbs, and every
node on no chain, fuse into one solid, which joins, cuts or intersects the
bodies around it like any other feature.

| gesture | what it does |
| --- | --- |
| click on a body | a node on its surface |
| click on a datum plane | a node on that plane |
| click in open space | a node on the plane facing you through the picked node, or on the ground |
| click a node | picks it and puts the move gizmo on it: arrows and squares move it, rings turn it, cubes resize it along its own axes |
| Alt-drag a node | pulls a linked copy out of it |
| Shift-click a node | links the picked node to it |
| Delete | removes the picked node |
| Enter, Esc | adds the body, or leaves without it |

With "Link new nodes" on, each new node extends the chain from the picked one,
so a limb is drawn by clicking along it. The picked node shows its size next to
it, and a dashed frame around all the nodes keeps the whole shape in view.

Every position, radius and turn is a row of the feature (`n3 Radius X`), so any
of them can be bound to a parameter from the properties panel. A binding names
the node by its id, never by its place in the list. A blend above 0 rounds the
junctions where limbs meet; when the kernel cannot round one, the body is kept
as it is and the feature says so.

## How the shape is made

A limb is a single smooth loft through an ellipse at every node, each normal to
the spine through the node centres and cut from that node's own ellipsoid, with
sections placed between nodes so the surface follows the spine. The caps are
further sections of the end nodes' ellipsoids closing to a point, so tube and
cap are one surface with no seam. A lone node is its ellipsoid.

Known limits: a chain that doubles back on itself tighter than its own radius
folds through itself and the kernel refuses it; very sharp bends between two
nodes pinch on the inside of the bend.

## Why it asks for what it asks for

| grant | what it does with it |
| --- | --- |
| `document.read` | reads the feature being edited and the bodies it may join or cut |
| `document.write` | adds the feature to your history |

It reads no files, writes no files, and reaches no network.
