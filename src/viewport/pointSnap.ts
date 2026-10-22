// Candidates are compared in screen pixels, as in sketch/snap.ts, so the reach is the same at every zoom, and
// ranked by kind: a placed corner beats a derived midpoint or centre, which beat a bare surface point.

/** What kind of point this is, which is also how strongly it is meant. */
export type ModelPointKind = "vertex" | "midpoint" | "center" | "surface";

export interface PointCandidate {
  p: [number, number, number];
  kind: ModelPointKind;
  /** The edge an end or middle sits on, so a datum can keep it as a reference. */
  edge?: { points: [number, number, number][]; body?: string | undefined; end: "start" | "end" | "mid" };
}

/** Higher is preferred where two candidates are both in reach. */
export const POINT_PRIORITY: Record<ModelPointKind, number> = {
  vertex: 100,
  midpoint: 80,
  center: 70,
  // Not a snap: offered so that aiming at the middle of a big face still lands on the model.
  surface: 10,
};

/** How near the cursor a candidate must project to count, in CSS pixels.
 *  Matching the sketcher's, so aiming feels the same in both places. */
export const POINT_SNAP_PX = 10;

/** A candidate `toScreen` cannot project (behind the camera) is skipped rather than guessed at. */
export function pickPoint(
  candidates: readonly PointCandidate[],
  toScreen: (p: readonly [number, number, number]) => { x: number; y: number } | null,
  at: { x: number; y: number },
  pixelTol = POINT_SNAP_PX,
): PointCandidate | null {
  let best: PointCandidate | null = null;
  let bestRank = -Infinity;
  let bestDist = Infinity;
  for (const c of candidates) {
    const s = toScreen(c.p);
    if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    const d = Math.hypot(s.x - at.x, s.y - at.y);
    if (d > pixelTol) continue;
    const rank = POINT_PRIORITY[c.kind];
    // Priority first, then distance: a vertex 9px away beats a surface point under the cursor, because
    // the surface point is not a point anyone chose.
    if (rank > bestRank || (rank === bestRank && d < bestDist)) {
      best = c;
      bestRank = rank;
      bestDist = d;
    }
  }
  return best;
}

/** By arc length, so a curved edge's middle is on the curve, not the chord. Null for a polyline with
 *  no length, such as a zero length run. */
export function polylineMidpoint3(
  pts: readonly (readonly [number, number, number])[],
): [number, number, number] | null {
  if (pts.length < 2) return null;
  const dist = (a: readonly number[], b: readonly number[]) =>
    Math.hypot(
      (b[0] as number) - (a[0] as number),
      (b[1] as number) - (a[1] as number),
      (b[2] as number) - (a[2] as number),
    );
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1] as readonly number[], pts[i] as readonly number[]);
    if (!Number.isFinite(d)) return null;
    total += d;
  }
  if (!(total > 0)) return null;
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as [number, number, number];
    const b = pts[i] as [number, number, number];
    const seg = dist(a, b);
    if (run + seg >= total / 2) {
      const t = seg > 0 ? (total / 2 - run) / seg : 0;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    }
    run += seg;
  }
  const last = pts[pts.length - 1] as [number, number, number];
  return [last[0], last[1], last[2]];
}
