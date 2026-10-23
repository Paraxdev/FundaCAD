// A Fillet or Chamfer click with members: on a member it drops it, on another edge it adds it, elsewhere nothing.
// A miss must not commit, a near miss on the third of four corners made a part with two.

export interface ScreenPt {
  x: number;
  y: number;
}

/** Infinity for no points. */
export function screenPolylineDist(pts: readonly ScreenPt[], p: ScreenPt): number {
  if (pts.length === 1) return Math.hypot(pts[0]!.x - p.x, pts[0]!.y - p.y);
  let best = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k]!,
      b = pts[k + 1]!;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y));
  }
  return best;
}

export type BlendClickTarget = "member" | "edge" | "none";

/** Edges right beside a member's line are mostly the blend's own preview, while an edge running on from the
 *  member's end should still win a few px along it. */
export const MEMBER_PREFERENCE_PX = 6;

/** Each candidate is its screen distance (the edge's is picking.EdgeCandidate.rankPx), null when out of reach. */
export function blendClickTarget(
  memberDist: number | null,
  edgeRankPx: number | null,
  radiusPx: number,
): BlendClickTarget {
  const m = memberDist != null && memberDist <= radiusPx ? memberDist : null;
  if (m != null && (edgeRankPx == null || m <= edgeRankPx + MEMBER_PREFERENCE_PX)) return "member";
  if (edgeRankPx != null) return "edge";
  return "none";
}

export function missPrompt(kind: "fillet" | "chamfer", members: number): string {
  const kept = `${members} edge${members === 1 ? "" : "s"} kept`;
  return `No edge there, ${kept} · click an edge to add it · Enter or ✓ to ${kind} · Esc`;
}
