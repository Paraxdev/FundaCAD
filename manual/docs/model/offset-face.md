# Offset face

Offset Face moves faces along their normals while the body stays closed, and the neighbouring faces stretch to follow. It works on flat and cylindrical faces, under Modify on the rail in the Shell group.

<!-- shot: offset-face | block face offset outward -->

1. Click Offset Face, then click a face. Ctrl-click adds more faces of the same body.
2. Drag the arrow, or type the distance.
3. Press Enter or click to apply, or Esc to cancel.

Letting go of the arrow only ends the drag, so you can still type a value.

A round face is resized instead of moved. A full cylinder takes a diameter, part of one takes a radius.

The value box has one option, depending on the face:

- Total, on a flat face of a wall: read and type the whole thickness to the opposite face instead of the change.
- Tangent faces follow, on a round face with faces running smoothly into it: on by default, those faces move along so a slot narrows as one. Off, a size they cannot meet is refused.
