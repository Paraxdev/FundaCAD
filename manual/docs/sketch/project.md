# Project the model

Project (P) copies existing geometry into the sketch, so you can draw against it.

<!-- shot: sketch-project | purple projected edges from a block -->

A bar of three choices opens with the tool, it sets what a click picks:

| Choice | Click | You get |
| --- | --- | --- |
| Edges & faces (the default) | an edge, or a face | the edge, or the face's outline |
| Sketch curves | a curve of an earlier sketch | a copy of that curve |
| Body silhouette | any face or edge of a body | the body's outline as seen from the sketch |

Projected curves are purple. They follow the model when it changes, so you cannot drag them, but you can constrain and dimension your own curves to them. A curve whose source is gone turns amber and keeps its last shape.

To edit one like an ordinary curve, right-click it and choose Break Link.

Project only sees what comes before the sketch in the History. Press Esc to leave the tool.
