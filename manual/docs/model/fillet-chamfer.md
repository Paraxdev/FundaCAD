# Fillet and chamfer

Fillet (F) rounds an edge and Chamfer (B) cuts it at an angle.

![A block edge being rounded, the radius box beside it](../img/fillet-edge.png)


![A fillet radius growing on an edge](../img/fillet-drag.gif)

Click an edge, drag or type a size, and press Enter. Selecting a face first treats every edge around it. Tab swaps between fillet and chamfer without starting over.

The three profile icons in the fillet box pick the continuity in one click. G1 is a circular round. G2 eases into the faces with no jump in curvature, so the highlight runs on smoothly, and G3 also has no jump in how fast the curvature changes. Keys 1, 2 and 3 pick them too, or Alt+1, Alt+2 and Alt+3 while you type the size.

A click takes the whole run of edges that flow smoothly from the one you picked. Shift+click takes exactly one. If the size is too big for the shape, the prompt says so and you type a smaller one.

## Continuity

G2 sets back 1.55 times the radius and G3 1.46 times, so on a narrow face they run off it sooner than G1. The profile works with all three.

G2 and G3 need both faces flat across the edge: a line between two flat faces at any angle, inside or outside, a flat face meeting a cylinder or cone around its rim, and the corner where three square faces meet with equal radii. On an edge that runs along a curved face, such as a flat face meeting a cylinder along its length, or any edge of a sphere, torus or freeform face, G2 and G3 are greyed out with the reason in their tooltip. Adding such an edge while G2 or G3 is chosen turns the fillet back to G1 and the prompt says why, and a document that asks for them there is refused with a message that offers G1.
