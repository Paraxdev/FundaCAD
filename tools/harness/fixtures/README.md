# Harness fixtures

Documents the harness tests open through File > Open. They are JSON documents, written by hand.

- `plate.json`: one 40 x 20 x 5 mm box centred on the origin, current document version.
- `plate_width.json`: the plate with a parameter `width` of 20 that nothing uses yet, for typing names into a value box.
- `block.json`: one 20 x 20 x 30 mm box centred on the origin, tall enough that a steep draft on a
  side face is refused, current document version.
- `steps.json`: three primitives named Base, Post and Ball that do not depend on each other, so the History tests
  can roll back, edit and reorder them by keys without breaking the build.
- `whole_sketch_extrude.json`: document version 9 on purpose, so opening it also runs the
  migration. Extrude `e` covers its whole 30 x 30 sketch and names no areas, extrude `e2` names an
  area by a point that is nowhere on its sketch, so that area is really gone.
- `zebra_joins.json`: three 30 x 30 x 25 mm blocks in a row for judging zebra stripes, the front top edge of the
  left one sharp (G0), of the middle one an 8 mm fillet (G1), of the right one an 8 mm G2 fillet.
- `zebra_wall.json`: a plain 30 mm extrusion whose front wall is a 32.5 mm radius arc between two flat sides.
