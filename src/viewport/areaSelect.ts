// Dragging a box over the model to take everything in it.
//
// Two boxes, and the drag itself says which one you meant. Dragging RIGHTWARD
// is a window: it takes only what lies wholly inside, so a box thrown across a
// crowded assembly takes the small parts and leaves the plate they sit on.
// Dragging LEFTWARD is crossing: it takes anything the box so much as touches,
// so a thin box swept down a row takes every hole it clips. The convention is
// old, it is unambiguous once you know it, and it costs no modifier key, which
// matters here because shift is already spoken for (adding to the selection).
//
// Everything in this file is 2D screen arithmetic on plain numbers: no camera,
// no scene graph, no DOM. The viewport projects the model once and asks these
// the questions; keeping the questions here is what lets vitest answer them
// without a canvas, and it is where the two verdicts stop being folklore.
//
// A vertex BEHIND the camera projects to nonsense, and nonsense that lands
// inside the box would select a face the user cannot see. Every predicate here
// treats a non-finite coordinate as "not in the box" rather than skipping it,
// so such a triangle fails the window test (not all of it is inside) and fails
// the crossing test (nothing provably touches). Both refusals are the safe way
// round: the box takes less than it might, never more.

/** How far the pointer must travel before a press is a box rather than a click.
 *  Just past the viewport's own 3px click/drag threshold, so a click that
 *  wobbles stays a click and never flashes a one-pixel rectangle. */
export const AREA_DRAG_MIN_PX = 4;

/** What a box takes. `window` = wholly inside; `crossing` = touched at all. */
export type AreaMode = "window" | "crossing";

/** WHICH KINDS a box takes. A box over a rounded corner covers the blend's
 *  edges and the four faces around them at once, and "select this region" is
 *  not the same request as "select these edges to fillet", so the gesture
 *  carries the answer instead of the next tool having to guess it.
 *
 *  `bodies` is the one that is NOT a narrowing of what a box already took: it
 *  takes whole bodies, whatever the viewport is picking at the time. The
 *  filter, not the current selection mode, decides what a box means, so a box
 *  thrown over an assembly can take its parts without first having to find the
 *  Faces/Bodies switch, and a box after that can take edges without switching
 *  back. `all` is the exception that keeps the gesture's old behaviour: it
 *  follows whatever mode you are already in. */
export type AreaFilter = "all" | "faces" | "edges" | "bodies";

/** The cycle Tab walks, in order. One list, so the chip on the box, the key,
 *  and the prompt can never disagree about what comes next. */
export const AREA_FILTERS: readonly AreaFilter[] = ["all", "faces", "edges", "bodies"];

/** The next filter after `f`. */
export function nextAreaFilter(f: AreaFilter): AreaFilter {
  const i = AREA_FILTERS.indexOf(f);
  return AREA_FILTERS[(i + 1) % AREA_FILTERS.length] as AreaFilter;
}

/** What to call the filter on screen. Reads as the object of a sentence,
 *  "taking EDGES fully inside the box", because that is one of the two places
 *  it is shown. */
export function areaFilterLabel(f: AreaFilter): string {
  return f === "all" ? "everything" : f;
}

/** The mark for the filter, an icons.ts name. The other place it is shown is a
 *  chip on the box itself, where a word would be read once and an icon is what
 *  makes the state legible at a glance on the twentieth box. */
export function areaFilterIcon(f: AreaFilter): string {
  return f === "faces" ? "face" : f === "edges" ? "edge" : f === "bodies" ? "body" : "select-all";
}

/** WHAT a box with this filter selects: bodies, or faces and edges.
 *
 *  A selection is one or the other, never both (viewport.selectionMode), so a
 *  box has to answer this before it can select anything, and the answer for
 *  `all` is "whatever you are already picking". Pure, because the rule is the
 *  thing worth pinning, the mode switch that follows from it is not. */
export function areaSelectionMode(
  f: AreaFilter,
  current: "faces" | "bodies",
): "faces" | "bodies" {
  if (f === "bodies") return "bodies";
  if (f === "all") return current;
  return "faces";
}

/** An axis-aligned rectangle in CSS pixels, already normalised so x0 <= x1 and
 *  y0 <= y1. */
export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The rectangle a drag covers and what it means.
 *
 *  The MODE reads the horizontal direction only. Vertical direction carries no
 *  meaning (a box dragged up and one dragged down are the same box), and using
 *  both would give four meanings to a gesture that has two. */
export function dragBox(ax: number, ay: number, bx: number, by: number): {
  rect: ScreenRect;
  mode: AreaMode;
} {
  return {
    rect: {
      x0: Math.min(ax, bx),
      y0: Math.min(ay, by),
      x1: Math.max(ax, bx),
      y1: Math.max(ay, by),
    },
    // Exactly vertical is a window: it is the degenerate case of neither
    // direction, and the stricter of the two verdicts is the one that cannot
    // surprise you with geometry you did not mean to take.
    mode: bx < ax ? "crossing" : "window",
  };
}

/** Is the drag far enough to mean a box? Measured as a corner-to-corner
 *  distance rather than per axis, so a diagonal flick of 3px by 3px does not
 *  qualify twice over. */
export function isAreaDrag(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.hypot(bx - ax, by - ay) >= AREA_DRAG_MIN_PX;
}

export function pointInRect(x: number, y: number, r: ScreenRect): boolean {
  return Number.isFinite(x) && Number.isFinite(y)
    && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

/** True when every point given lies in the rectangle. The `window` half of the
 *  verdict, for a triangle or a polyline alike. */
export function allInsideRect(pts: readonly number[], r: ScreenRect): boolean {
  if (pts.length < 2) return false;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    if (!pointInRect(pts[i] as number, pts[i + 1] as number, r)) return false;
  }
  return true;
}

/** True when a convex shape, given as flat x,y pairs, overlaps the rectangle
 *  at all, including the case where the rectangle is wholly INSIDE it.
 *
 *  Separating-axis, over the rectangle's two axes and the shape's own edge
 *  normals. Two convex shapes miss each other exactly when some such axis
 *  separates their projections, so this is not an approximation: a small box
 *  dropped in the middle of one enormous triangle is a hit, which is the case a
 *  vertex-only test gets wrong and the case a user hits constantly (a box
 *  dragged inside one big face of a plate).
 *
 *  Works for a two-point shape, a line segment, where the one edge normal is
 *  the only axis the rectangle's own two do not already cover. */
export function convexTouchesRect(pts: readonly number[], r: ScreenRect): boolean {
  const n = pts.length >> 1;
  if (n < 1) return false;
  for (let i = 0; i < n * 2; i++) if (!Number.isFinite(pts[i] as number)) return false;
  if (n === 1) return pointInRect(pts[0] as number, pts[1] as number, r);

  // the rectangle's own axes first: they are the cheapest and reject most
  if (!spansOverlap(pts, 1, 0, r)) return false;
  if (!spansOverlap(pts, 0, 1, r)) return false;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = (pts[j * 2] as number) - (pts[i * 2] as number);
    const dy = (pts[j * 2 + 1] as number) - (pts[i * 2 + 1] as number);
    // A zero-length edge (a degenerate triangle, a repeated polyline sample)
    // has no normal. Skipping it is right rather than lenient: the shape it
    // belongs to is still covered by its remaining axes.
    if (dx === 0 && dy === 0) continue;
    if (!spansOverlap(pts, -dy, dx, r)) return false;
    if (n === 2) break; // a segment's two "edges" are the same line
  }
  return true;
}

/** Do the shape's and the rectangle's projections onto (nx, ny) overlap? */
function spansOverlap(pts: readonly number[], nx: number, ny: number, r: ScreenRect): boolean {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const d = (pts[i] as number) * nx + (pts[i + 1] as number) * ny;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  let rlo = Infinity;
  let rhi = -Infinity;
  for (const [x, y] of [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]] as const) {
    const d = x * nx + y * ny;
    if (d < rlo) rlo = d;
    if (d > rhi) rhi = d;
  }
  return !(hi < rlo || rhi < lo);
}

// ---- what a bounding box alone can settle -----------------------------------
//
// The box has to be answered while it is still being DRAGGED, so the same
// question is asked of the same geometry sixty times a second. What makes that
// affordable is that most of the model is nowhere near the box, and a screen
// bounding box per face settles that without looking at a single triangle.
//
// For a WINDOW it settles the whole question, not just the cheap half: "every
// point inside the rectangle" is exactly "the bounding box is inside the
// rectangle", so a window never walks a triangle at all. For a CROSSING it can
// only rule out, because two boxes overlapping does not mean the shapes do.

/** A shape's screen extent as [x0, y0, x1, y1], or null when some of it is
 *  behind the camera and has no honest screen position. */
export type ScreenBox = readonly [number, number, number, number] | null;

/** The extent of flat x,y pairs, or null if any of them is not finite. */
export function boxOf(pts: readonly number[]): ScreenBox {
  if (pts.length < 2) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const x = pts[i] as number;
    const y = pts[i + 1] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

/** Grow a box to hold another. Either being null makes the result null: a shape
 *  partly behind the camera has no extent, and pretending otherwise would let
 *  the half that is on screen answer for the half that is not. */
export function unionBox(a: ScreenBox, b: ScreenBox): ScreenBox {
  if (a === null || b === null) return null;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** The verdict the box alone gives: `true` taken, `false` not taken, or "look"
 *  when only the triangles can say.
 *
 *  A null box is not taken by a window (a point behind the camera is not inside
 *  anything) and is "look" for a crossing (the part of it that IS on screen may
 *  well touch, and the per-triangle tests already refuse non-finite points). */
export function boxVerdict(
  b: ScreenBox,
  r: ScreenRect,
  mode: AreaMode,
): boolean | "look" {
  if (mode === "window") {
    return b !== null && b[0] >= r.x0 && b[1] >= r.y0 && b[2] <= r.x1 && b[3] <= r.y1;
  }
  if (b === null) return "look";
  return b[0] > r.x1 || b[2] < r.x0 || b[1] > r.y1 || b[3] < r.y0 ? false : "look";
}

/** Does a polyline, a model edge, projected, fall in the box?
 *
 *  In `window` mode every sample must be inside, which is the honest reading of
 *  "wholly inside" for a curve we only know by its samples. In `crossing` mode
 *  each SEGMENT is tested, so a long edge that merely passes through the box
 *  with no sample in it still counts, and that is most of what crossing is for.
 */
export function polylineInBox(
  pts: readonly number[],
  r: ScreenRect,
  mode: AreaMode,
): boolean {
  if (pts.length < 2) return false;
  if (mode === "window") return allInsideRect(pts, r);
  if (pts.length === 2) return pointInRect(pts[0] as number, pts[1] as number, r);
  for (let i = 0; i + 3 < pts.length; i += 2) {
    if (convexTouchesRect(pts.slice(i, i + 4), r)) return true;
  }
  return false;
}

/** Does one projected triangle fall in the box? */
export function triangleInBox(
  tri: readonly number[],
  r: ScreenRect,
  mode: AreaMode,
): boolean {
  return mode === "window" ? allInsideRect(tri, r) : convexTouchesRect(tri, r);
}

/** The verdict for a whole FACE, folded over its triangles.
 *
 *  A window takes the face only if every triangle is inside it, anything less
 *  and part of the face is outside the box the user drew. Crossing takes it as
 *  soon as one triangle is touched, and stops looking, which is what keeps a
 *  crossing box over a 200k-triangle import from walking all of it.
 *
 *  An empty triangle list is NOT a hit either way. It is what a face reduced to
 *  nothing by the caller's own visibility filter looks like, and a face with no
 *  visible part of it is not one the box can have meant.
 */
export function faceInBox(
  tris: Iterable<readonly number[]>,
  r: ScreenRect,
  mode: AreaMode,
): boolean {
  let any = false;
  for (const t of tris) {
    any = true;
    const hit = triangleInBox(t, r, mode);
    if (mode === "crossing") {
      if (hit) return true;
    } else if (!hit) {
      return false;
    }
  }
  return mode === "window" ? any : false;
}
