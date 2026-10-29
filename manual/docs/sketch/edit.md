# Change what you drew

With no tool running, clicks select and drag what you drew.

- Click a shape to select it. Shift or Ctrl click adds more.
- Drag across empty space for a box. Left to right takes what lies wholly inside, right to left also takes what it touches.
- Drag a point or a line to move it.
- Press Delete to remove the selection, or right-click it and pick Delete.

## Edit tools

| Tool | What it does | What you click |
| --- | --- | --- |
| Trim (T) | Removes a piece of a curve up to where it crosses others. A curve that crosses nothing goes whole. | The piece to remove |
| Extend | Grows a line or arc to the next curve it meets | Near the end to grow |
| Break | Splits a line or arc in two | Where to split it |
| Fillet (F) | Rounds the corner between two lines | Two lines, then type the radius in R |
| Chamfer | Cuts the corner off straight | Two lines, then type the setback in D |
| Offset (O) | Draws a parallel copy | A curve or a face edge, then move the mouse to the side and distance, or type it |

The Offset button also holds Extend and Break, and the Fillet button holds Chamfer.

Right-click while placing an offset to switch Chain Selection or Flip the side. With Chain Selection on, as it starts, the whole connected outline offsets as one.

## Move, turn and resize

Select shapes and press M for Move/Rotate. The gizmo appears in the sketch: drag an arrow or the square to slide, the ring to turn, a cube to resize. Enter applies and Esc drops it. [Move](../model/move.md) explains the gizmo.

With nothing selected, Move/Rotate asks you to select shapes, then click a point to move from and a point to move to.

Copy, Rotate and Scale are in the command palette (Ctrl+K).

## Mirror

1. Select what to mirror, then click Mirror on the rail. A panel opens with two lists, Objects and Mirror line, and your selection is already in Objects.
2. Click the line to mirror across. It can be a line, a construction line, a projected edge, or the X or Y axis through the origin.
3. Check the preview, then press Enter or click Mirror.

With nothing selected, Mirror starts on Objects. Click shapes, or inside a closed shape to take its whole outline, then press Enter to move on to Mirror line.

- Shift or Ctrl click always adds to Objects.
- Click a list, or press Tab, to choose which one your clicks fill.
- Esc cancels and gives back the selection you had.
