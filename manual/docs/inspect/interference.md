# Interference

Interference lists bodies that overlap, which you want to know before printing an assembly.

![Interference panel naming one clash between a box and a cylinder with its overlap volume](../img/interference-list.png)

Each row names a pair and the size of the overlap, and a click highlights the pair. Clearance mode lists pairs closer than a distance you type, and 0.2 mm is a sensible first try.

Only closed solids can be checked. A body that is a surface, or an import whose faces do not close properly, is listed as not checked with the reason, so an empty list never hides it.
