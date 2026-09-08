// How far a fillet/chamfer drag has gone, measured against the EDGE.
//
// The gesture is "swipe away from the edge": how far you are from it is the
// radius or the setback, and which side you are on picks which of the two. The
// measurement therefore has to be the cursor's distance from the edge, and
// nothing else. It was the cursor's travel along a 3D axis instead
// (manipulator.axisDragDistance), which is right for press/pull, there the
// face really does move along a world direction and the projection IS the
// answer, and wrong here, because a radius is a size rather than a
// translation, and there is no world direction it is a distance along.
//
// The symptom was the axis's own degenerate case. When an axis leans toward the
// camera there is nothing left to project onto, so that function falls back to
// the cursor's VERTICAL screen position, and the drag stops asking how far you
// are from the edge and starts asking how near the top of the window you are.
// On a rim seen close to edge-on that is most of the gesture. Measuring in the
// screen plane against the edge's own projected direction has no such case: an
// edge that projects to a point is the one degeneracy, and there every
// direction is genuinely "away from the edge", which is exactly what the
// fallback below does.
//
// Pixels in, pixels out. The caller scales by pixelWorldSize at the anchor, the
// same conversion the manipulator has always used at its own degeneracy.

export interface Pt {
  x: number;
  y: number;
}

const EPS = 1e-9;
/** Below this the edge's projection is too short to give a reliable direction,
 *  it is a few pixels long on screen, and the perpendicular derived from it
 *  would swing wildly with the projection's own rounding. In pixels. */
const MIN_EDGE_PX = 4;

function norm(p: Pt): Pt | null {
  const len = Math.hypot(p.x, p.y);
  return len > EPS ? { x: p.x / len, y: p.y / len } : null;
}

/** Signed distance from `cursor` to the line through `origin` running along
 *  `edgeDir`, positive on the side `outward` points to. Every argument is in
 *  screen pixels, and `edgeDir` / `outward` are directions rather than points.
 *
 *  It is the distance to the LINE, not to the segment: dragging off the end of
 *  a short edge still means the same radius it meant beside the middle of it,
 *  and a blend has no ends to fall off anyway, it runs the length of the edge
 *  whatever the cursor is next to.
 *
 *  `outward` decides only the sign. It is the handle's own direction, so the
 *  side the arrow points to is the treatment the arrow opened on, and the far
 *  side is the other one. When the edge projects to a point (seen end-on) there
 *  is no perpendicular to take, and the offset falls back to travel along
 *  `outward` itself, at that angle any direction leads away from the edge, so
 *  the arrow is the only thing left that distinguishes the two sides. */
export function swipeOffsetPx(origin: Pt, edgeDir: Pt, outward: Pt, cursor: Pt): number {
  const d = { x: cursor.x - origin.x, y: cursor.y - origin.y };
  const out = norm(outward);
  const t = Math.hypot(edgeDir.x, edgeDir.y) >= MIN_EDGE_PX ? norm(edgeDir) : null;
  if (!t) return out ? d.x * out.x + d.y * out.y : 0;
  // Either perpendicular of the edge will do; `outward` says which one.
  let n = { x: -t.y, y: t.x };
  if (out && n.x * out.x + n.y * out.y < 0) n = { x: -n.x, y: -n.y };
  return d.x * n.x + d.y * n.y;
}
