// How far a fillet or chamfer drag has gone: the cursor's screen distance from the edge, its side picking the
// treatment. Not axis travel (manipulator.axisDragDistance), whose edge-on fallback reads the cursor's height in the
// window. Pixels in and out, the caller scales by pixelWorldSize at the anchor.

export interface Pt {
  x: number;
  y: number;
}

const EPS = 1e-9;
/** Pixels. A shorter projection gives a perpendicular that swings with the projection's rounding. */
const MIN_EDGE_PX = 4;

function norm(p: Pt): Pt | null {
  const len = Math.hypot(p.x, p.y);
  return len > EPS ? { x: p.x / len, y: p.y / len } : null;
}

/** All in screen pixels. To the line, not the segment, since a blend runs the edge's whole length. `outward` sets
 *  only the sign; with the edge seen end on there is no perpendicular, and it falls back to travel along `outward`. */
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
