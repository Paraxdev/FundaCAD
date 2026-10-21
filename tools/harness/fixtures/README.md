# Harness fixtures

Documents the harness tests open through File > Open. They are JSON documents, written by hand.

- `plate.json`: one 40 x 20 x 5 mm box centred on the origin, current document version.
- `block.json`: one 20 x 20 x 30 mm box centred on the origin, tall enough that a steep draft on a
  side face is refused, current document version.
- `whole_sketch_extrude.json`: document version 9 on purpose, so opening it also runs the
  migration. Extrude `e` covers its whole 30 x 30 sketch and names no areas, extrude `e2` names an
  area by a point that is nowhere on its sketch, so that area is really gone.
