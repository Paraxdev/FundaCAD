# Fillet and chamfer

Fillet (F) rounds an edge and Chamfer (B) cuts it at an angle.

![A block edge being rounded, the radius box beside it](../img/fillet-edge.png)


![A fillet radius growing on an edge](../img/fillet-drag.gif)

Click an edge, drag or type a size, and press Enter. Selecting a face first treats every edge around it. Tab swaps between fillet and chamfer without starting over.

The two profile icons in the fillet box pick the continuity in one click. G1 is a circular round. G2 eases into the faces with no jump in curvature, so the highlight runs on smoothly. Keys 1 and 2 pick them too, or Alt+1 and Alt+2 while you type the size.

A click takes the whole run of edges that flow smoothly from the one you picked. Shift+click takes exactly one. If the size is too big for the shape, the prompt says so and you type a smaller one.
