// Matching saved edge selectors (world space midpoints) back to rendered polylines. Edge ids change on every rebuild,
// so geometry is the only stable edge identity.

export type Vec3 = [number, number, number];

/** The arc length midpoint. Every site that builds or matches a selector must use it: the index middle of a two point
 *  straight edge is its end, which resolved a picked edge to its neighbour. */
export function polylineMid(points: Vec3[]): Vec3 | undefined {
  const first = points[0];
  if (!first) return undefined;
  if (points.length === 1) return first;
  const seg: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const d = Math.sqrt(d2(points[i - 1]!, points[i]!));
    seg.push(d);
    total += d;
  }
  if (total <= 0) return first; // degenerate (all samples coincident)
  let want = total / 2;
  for (let i = 0; i < seg.length; i++) {
    const s = seg[i]!;
    if (want <= s || i === seg.length - 1) {
      const t = s > 0 ? want / s : 0;
      const a = points[i]!,
        b = points[i + 1]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    want -= s;
  }
  return points[points.length - 1];
}

/** The old index middle convention, only so documents saved with it still re-match their edges on reopen. Never build a
 *  new selector from this. */
function legacyPolylineMid(points: Vec3[]): Vec3 | undefined {
  return points[Math.floor(points.length / 2)];
}

const d2 = (a: Vec3, b: Vec3): number => {
  const dx = a[0] - b[0],
    dy = a[1] - b[1],
    dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
};

/** Nearest midpoint within `tol` (world units), the first wins a tie, null for none. Accepts both midpoint conventions
 *  (legacyPolylineMid). */
export function nearestEdgeByMid(edges: { points: Vec3[] }[], mid: Vec3, tol: number): number | null {
  let best = -1;
  let bestD = tol * tol;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!e) continue;
    for (const m of [polylineMid(e.points), legacyPolylineMid(e.points)]) {
      if (!m) continue;
      const dd = d2(m, mid);
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    }
  }
  return best >= 0 ? best : null;
}

/** nearestEdgeByMid over a fixed edge list, built once in O(E): every mid in a hash of `tol` sized cells, a lookup reads
 *  the 27 cells around it. Drop it on any model change, it would match the edges of the previous model. */
export class EdgeMidIndex {
  private readonly cells = new Map<number, number[]>();
  private readonly mids: (Vec3 | undefined)[] = [];
  private readonly cell: number;

  constructor(
    edges: readonly { points: Vec3[] }[],
    private readonly tol: number,
  ) {
    this.cell = tol > 0 && Number.isFinite(tol) ? tol : 1;
    for (let i = 0; i < edges.length; i++) {
      const pts = edges[i]?.points ?? [];
      const a = polylineMid(pts),
        b = legacyPolylineMid(pts);
      this.mids.push(a, b);
      if (a) this.put(a, i);
      if (b) this.put(b, i);
    }
  }

  private coord(v: number): number {
    return Math.floor(v / this.cell);
  }

  private hash(x: number, y: number, z: number): number {
    return Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791);
  }

  private put(p: Vec3, i: number) {
    const k = this.hash(this.coord(p[0]), this.coord(p[1]), this.coord(p[2]));
    const list = this.cells.get(k);
    if (!list) this.cells.set(k, [i]);
    else if (list[list.length - 1] !== i) list.push(i);
  }

  nearest(mid: Vec3): number | null {
    let best = -1;
    let bestD = this.tol * this.tol;
    if (!(bestD > 0)) return null;
    const cx = this.coord(mid[0]),
      cy = this.coord(mid[1]),
      cz = this.coord(mid[2]);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = this.cells.get(this.hash(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (const i of list) {
            for (let k = 2 * i; k <= 2 * i + 1; k++) {
              const m = this.mids[k];
              if (!m) continue;
              const dd = d2(m, mid);
              // The scan keeps the first edge on a tie, the cells hold edges out of order.
              if (dd < bestD || (dd === bestD && best >= 0 && i < best)) {
                bestD = dd;
                best = i;
              }
            }
          }
        }
    return best >= 0 ? best : null;
  }
}

/** The engine's `by:"nearest"` rule, the fallback for a selector point that is not a midpoint (hand written, MCP, a
 *  loop). Null unless clear: within a quarter of the edge's length (at most `cap`) and half as far as the next edge. */
export function nearestEdgeByCurve(edges: { points: Vec3[] }[], point: Vec3, cap: number): number | null {
  let best = -1,
    bestD = Infinity,
    secondD = Infinity;
  for (let i = 0; i < edges.length; i++) {
    const pts = edges[i]?.points;
    if (!pts?.length) continue;
    let d = Infinity;
    const n = Math.max(1, pts.length - 1);
    for (let k = 0; k < n; k++) d = Math.min(d, segD2(pts[k]!, pts[Math.min(k + 1, pts.length - 1)]!, point));
    d = Math.sqrt(d);
    if (d < bestD) {
      secondD = bestD;
      bestD = d;
      best = i;
    } else if (d < secondD) {
      secondD = d;
    }
  }
  if (best < 0) return null;
  const tol = Math.min(cap, Math.max(0.5, 0.25 * polylineLength(edges[best]!.points)));
  if (bestD > tol || bestD > 0.5 * secondD) return null;
  return best;
}

function polylineLength(points: Vec3[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.sqrt(d2(points[i - 1]!, points[i]!));
  return total;
}

function segD2(a: Vec3, b: Vec3, p: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t =
    len2 > 0
      ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / len2))
      : 0;
  return d2([a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t], p);
}

/** Removes a selector within `tol` of `mid`, or appends `{kind:"edge", by:"nearest", point: mid}`. Returns a new array. */
export function toggleSelectorByMid<S extends { point?: number[] }>(
  selectors: S[],
  mid: Vec3,
  tol: number,
): (S | { kind: "edge"; by: "nearest"; point: Vec3 })[] {
  const t2 = tol * tol;
  const kept = selectors.filter((s) => !(s.point && s.point.length === 3 && d2(s.point as Vec3, mid) <= t2));
  if (kept.length !== selectors.length) return kept;
  return [...selectors, { kind: "edge", by: "nearest", point: mid }];
}

/** Absorbs the engine's 3dp rounding and coarse tessellation midpoint drift without letting nearby parallel edges
 *  cross-match. */
export function midMatchTol(bboxDiag: number): number {
  return Math.max(0.5, 0.005 * bboxDiag);
}

/** Every site minting an edge selector goes through here: without the body the engine picks from the active body and
 *  silently blends the wrong body's edge. `body` is omitted, not undefined, so saved files stay byte stable. */
export function edgeSelectorFrom(edge: {
  points: Vec3[];
  body?: string | undefined;
}): { kind: "edge"; by: "nearest"; point: Vec3; body?: string } | undefined {
  const mid = polylineMid(edge.points);
  if (!mid) return undefined;
  const sel = { kind: "edge" as const, by: "nearest" as const, point: mid };
  return edge.body ? { ...sel, body: edge.body } : sel;
}

/** For references that must survive the edge moving or changing length, where a `nearest` point would land on another
 *  edge. Same body rule as above. */
export function edgeMatchSelectorFrom(edge: {
  points: Vec3[];
  body?: string | undefined;
}):
  | { kind: "edge"; by: "match"; fp: { mid: Vec3; dir: Vec3; length: number; curve?: "line" }; body?: string }
  | undefined {
  const pts = edge.points;
  const mid = polylineMid(pts);
  const a = pts[0];
  const b = pts[pts.length - 1];
  if (!mid || !a || !b || pts.length < 2) return undefined;
  let length = 0;
  let half: [Vec3, Vec3] = [a, b];
  for (let i = 1; i < pts.length; i++) length += dist(pts[i - 1]!, pts[i]!);
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1]!, pts[i]!);
    if (run + d >= length / 2) {
      half = [pts[i - 1]!, pts[i]!];
      break;
    }
    run += d;
  }
  const chord = dist(a, b);
  const straight = chord > 1e-9 && Math.abs(length - chord) < 1e-6 * Math.max(1, length);
  const [p, q] = straight ? [a, b] : half;
  let dir: Vec3 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
  const n = Math.hypot(dir[0], dir[1], dir[2]);
  if (n < 1e-12) return undefined;
  dir = [dir[0] / n, dir[1] / n, dir[2] / n];
  const lead = dir.find((c) => Math.abs(c) > 1e-9) ?? 1;
  if (lead < 0) dir = [0 - dir[0], 0 - dir[1], 0 - dir[2]];
  const fp = { mid, dir, length, ...(straight ? { curve: "line" as const } : {}) };
  const sel = { kind: "edge" as const, by: "match" as const, fp };
  return edge.body ? { ...sel, body: edge.body } : sel;
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
