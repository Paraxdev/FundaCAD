// "Which point on the model did I just aim at?" — the choice, without the
// camera.
//
// The sketcher has had this since it was written (sketch/snap.ts): candidates
// compared in SCREEN PIXELS so the reach is the same at every zoom, ranked by
// what kind of point they are so the specific beats the vague where two land on
// the same pixel. Nothing in 3D had it, which is why the transform gizmo's
// origin could sit anywhere except somewhere meaningful.
//
// The ranking is the content. A corner is a point somebody put there; the middle
// of an edge is derived from two of those; the centre of a face is derived from
// its whole boundary; and a bare point on a surface is wherever the cursor
// happened to be. Under the pixel tolerance they are frequently all available at
// once, and the order is which of them the user meant.

/** What kind of point this is, which is also how strongly it is meant. */
export type ModelPointKind = "vertex" | "midpoint" | "center" | "surface";

export interface PointCandidate {
  p: [number, number, number];
  kind: ModelPointKind;
}

/** Higher wins where two candidates are both in reach. */
export const POINT_PRIORITY: Record<ModelPointKind, number> = {
  vertex: 100,
  midpoint: 80,
  center: 70,
  // Not a snap at all: the bare surface under the cursor, offered so that
  // aiming at the middle of a big face still lands ON the model rather than
  // nowhere. Anything else in reach beats it.
  surface: 10,
};

/** How near the cursor a candidate must project to count, in CSS pixels.
 *  Matching the sketcher's, so aiming feels the same in both places. */
export const POINT_SNAP_PX = 10;

/** The point the cursor means, or null when nothing is in reach.
 *
 *  `toScreen` may return null for a candidate behind the camera; such a
 *  candidate is skipped rather than guessed at, exactly as the area box skips a
 *  vertex it cannot project.
 */
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
    // Priority first, then distance. Two candidates of the same kind on the
    // same pixel is a genuine tie and the nearer one is as good an answer as
    // there is; a vertex 9px away still beats a surface point under the cursor,
    // because the surface point is not a point anyone chose.
    if (rank > bestRank || (rank === bestRank && d < bestDist)) {
      best = c;
      bestRank = rank;
      bestDist = d;
    }
  }
  return best;
}

/** The midpoint of a polyline BY ARC LENGTH, so a curved edge's middle is on
 *  the curve rather than on the chord. Null for a polyline with no length —
 *  a closed edge's ends coincide, and the middle of a zero-length run is not a
 *  point worth aiming at. */
export function polylineMidpoint3(
  pts: readonly (readonly [number, number, number])[],
): [number, number, number] | null {
  if (pts.length < 2) return null;
  const dist = (a: readonly number[], b: readonly number[]) =>
    Math.hypot((b[0] as number) - (a[0] as number), (b[1] as number) - (a[1] as number), (b[2] as number) - (a[2] as number));
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
