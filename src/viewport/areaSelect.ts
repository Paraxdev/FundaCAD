// Box selection in screen space: a rightward drag is a window (wholly inside), a leftward one a crossing (touched at
// all). A non-finite point, one behind the camera, is never in the box, so a box takes less than it might, never more.

/** Just past the viewport's 3px click threshold, so a wobbling click never flashes a one pixel box. */
export const AREA_DRAG_MIN_PX = 4;

/** What a box takes. `window` = wholly inside; `crossing` = touched at all. The drag direction picks it, as Shift
 *  already adds to the selection. */
export type AreaMode = "window" | "crossing";

/** `bodies` takes whole bodies whatever the viewport is picking; `all` follows the current selection mode; `profiles`
 *  takes only the areas of visible sketches. */
export type AreaFilter = "all" | "faces" | "profiles" | "edges" | "bodies";

/** The order Tab cycles through, shared by the chip on the box, the key and the prompt. */
export const AREA_FILTERS: readonly AreaFilter[] = ["all", "faces", "profiles", "edges", "bodies"];

export function nextAreaFilter(f: AreaFilter): AreaFilter {
  const i = AREA_FILTERS.indexOf(f);
  return AREA_FILTERS[(i + 1) % AREA_FILTERS.length] as AreaFilter;
}

/** Reads as the object of a sentence: "taking EDGES fully inside the box". */
export function areaFilterLabel(f: AreaFilter): string {
  return f === "all" ? "everything" : f === "profiles" ? "sketch profiles" : f;
}

/** An icons.ts name, shown on the chip on the box. */
export function areaFilterIcon(f: AreaFilter): string {
  return f === "faces"
    ? "face"
    : f === "profiles"
      ? "sketch"
      : f === "edges"
        ? "edge"
        : f === "bodies"
          ? "body"
          : "select-all";
}

/** A selection is bodies or faces and edges, never both (viewport.selectionMode); `all` keeps the current one. */
export function areaSelectionMode(f: AreaFilter, current: "faces" | "bodies"): "faces" | "bodies" {
  if (f === "bodies") return "bodies";
  if (f === "all") return current;
  return "faces";
}

/** A sketch's areas count as faces: Faces and a faces mode Everything take them beside the model's own. */
export function areaTakesProfiles(f: AreaFilter, kind: "faces" | "bodies"): boolean {
  return f === "profiles" || (kind === "faces" && (f === "faces" || f === "all"));
}

/** Even-odd over a closed outline of flat x,y pairs. */
function pointInOutline(x: number, y: number, pts: readonly number[]): boolean {
  let inside = false;
  const n = pts.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2] as number;
    const yi = pts[i * 2 + 1] as number;
    const xj = pts[j * 2] as number;
    const yj = pts[j * 2 + 1] as number;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A sketch area by its outer outline on screen. A crossing also takes an area the box lies wholly inside. */
export function outlineInBox(pts: readonly number[], r: ScreenRect, mode: AreaMode): boolean {
  if (pts.length < 6) return false;
  if (mode === "window") return allInsideRect(pts, r);
  if (!pts.every(Number.isFinite)) return false;
  const closed = [...pts, pts[0] as number, pts[1] as number];
  return polylineInBox(closed, r, "crossing") || pointInOutline(r.x0, r.y0, pts);
}

/** CSS pixels, normalised so x0 <= x1 and y0 <= y1. */
export interface ScreenRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The mode reads the horizontal direction only, the vertical one means nothing. */
export function dragBox(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): {
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
    // Exactly vertical is a window, the stricter of the two verdicts.
    mode: bx < ax ? "crossing" : "window",
  };
}

/** Measured corner to corner rather than per axis. */
export function isAreaDrag(ax: number, ay: number, bx: number, by: number): boolean {
  return Math.hypot(bx - ax, by - ay) >= AREA_DRAG_MIN_PX;
}

export function pointInRect(x: number, y: number, r: ScreenRect): boolean {
  return Number.isFinite(x) && Number.isFinite(y) && x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
}

/** The `window` verdict, for a triangle or a polyline alike. */
export function allInsideRect(pts: readonly number[], r: ScreenRect): boolean {
  if (pts.length < 2) return false;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    if (!pointInRect(pts[i] as number, pts[i + 1] as number, r)) return false;
  }
  return true;
}

/** Separating axis test over the rectangle's axes and the shape's edge normals, so it is exact: a small box inside one
 *  huge triangle is a hit. A two point shape is a segment. */
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
    // A zero length edge has no normal, the shape's other axes still cover it.
    if (dx === 0 && dy === 0) continue;
    if (!spansOverlap(pts, -dy, dx, r)) return false;
    if (n === 2) break; // a segment's two "edges" are the same line
  }
  return true;
}

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
  for (const [x, y] of [
    [r.x0, r.y0],
    [r.x1, r.y0],
    [r.x1, r.y1],
    [r.x0, r.y1],
  ] as const) {
    const d = x * nx + y * ny;
    if (d < rlo) rlo = d;
    if (d > rhi) rhi = d;
  }
  return !(hi < rlo || rhi < lo);
}

// Screen bounding boxes answer most of the model at drag rate: they settle a window outright, and a crossing when the
// shape's box misses the rect or lies wholly inside it.

/** [x0, y0, x1, y1], or null when part of the shape is behind the camera. */
export type ScreenBox = readonly [number, number, number, number] | null;

/** The extent of flat x,y pairs, or null if any of them is not finite. */
export function boxOf(pts: readonly number[]): ScreenBox {
  if (pts.length < 2) return null;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
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

/** Null wins: a shape partly behind the camera has no honest extent. */
export function unionBox(a: ScreenBox, b: ScreenBox): ScreenBox {
  if (a === null || b === null) return null;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** `true` taken, `false` not, "look" when only the triangles can say. A null box fails a window and is "look" for a
 *  crossing. */
export function boxVerdict(b: ScreenBox, r: ScreenRect, mode: AreaMode): boolean | "look" {
  if (mode === "window") {
    return b !== null && b[0] >= r.x0 && b[1] >= r.y0 && b[2] <= r.x1 && b[3] <= r.y1;
  }
  if (b === null) return "look";
  if (b[0] > r.x1 || b[2] < r.x0 || b[1] > r.y1 || b[3] < r.y0) return false;
  return b[0] >= r.x0 && b[1] >= r.y0 && b[2] <= r.x1 && b[3] <= r.y1 ? true : "look";
}

/** A window needs every sample inside. A crossing tests each segment, so an edge passing through with no sample
 *  inside still counts. */
export function polylineInBox(pts: readonly number[], r: ScreenRect, mode: AreaMode): boolean {
  if (pts.length < 2) return false;
  if (mode === "window") return allInsideRect(pts, r);
  if (pts.length === 2) return pointInRect(pts[0] as number, pts[1] as number, r);
  for (let i = 0; i + 3 < pts.length; i += 2) {
    if (convexTouchesRect(pts.slice(i, i + 4), r)) return true;
  }
  return false;
}

export function triangleInBox(tri: readonly number[], r: ScreenRect, mode: AreaMode): boolean {
  return mode === "window" ? allInsideRect(tri, r) : convexTouchesRect(tri, r);
}

/** A window needs every triangle inside, a crossing stops at the first hit. An empty list is never a hit: the caller's
 *  visibility filter emptied that face. */
export function faceInBox(tris: Iterable<readonly number[]>, r: ScreenRect, mode: AreaMode): boolean {
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

/** Runs a box preview at most once an animation frame. A burst of pointer moves inside one frame repainted the take
 *  once per event on a big model, the viewport keeps the latest point itself. */
export class FrameCoalescer {
  private queued: number | null = null;

  constructor(
    private run: () => void,
    private frame: (fn: () => void) => number = (fn) => requestAnimationFrame(fn),
    private cancelFrame: (id: number) => void = (id) => cancelAnimationFrame(id),
  ) {}

  queue() {
    if (this.queued !== null) return;
    this.queued = this.frame(() => {
      this.queued = null;
      this.run();
    });
  }

  cancel() {
    if (this.queued !== null) this.cancelFrame(this.queued);
    this.queued = null;
  }

  /** A move's own frame callback runs after the render loop's of that frame, so the loop runs it first. */
  flush() {
    if (this.queued === null) return;
    this.cancel();
    this.run();
  }
}
