// A Fillet or Chamfer click with members: on a member it drops it, on another edge it adds it, elsewhere nothing.
// A miss must not commit, a near miss on the third of four corners made a part with two.

import { t } from "../i18n";

export interface ScreenPt {
  x: number;
  y: number;
}

/** Infinity for no points. */
export function screenPolylineDist(pts: readonly ScreenPt[], p: ScreenPt): number {
  return screenPolylineNearest(pts, p).dist;
}

/** The polyline's nearest approach to `p`: its distance, and the segment and fraction along it where it falls. */
export function screenPolylineNearest(pts: readonly ScreenPt[], p: ScreenPt): { dist: number; seg: number; t: number } {
  if (pts.length === 1) return { dist: Math.hypot(pts[0]!.x - p.x, pts[0]!.y - p.y), seg: 0, t: 0 };
  let best = { dist: Infinity, seg: 0, t: 0 };
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k]!,
      b = pts[k + 1]!;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const dist = Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y);
    if (dist < best.dist) best = { dist, seg: k, t };
  }
  return best;
}

export type BlendClickTarget = "member" | "edge" | "none";

/** Edges right beside a member's line are mostly the blend's own preview, while an edge running on from the
 *  member's end should still win a few px along it. */
export const MEMBER_PREFERENCE_PX = 6;

/** Lines this close on screen read as one line, so the one nearer the eye is the one clicked. */
export const COINCIDE_PX = 2;

/** Each candidate is its screen distance (the edge's is picking.EdgeCandidate.rankPx), null when out of reach.
 *  `memberBehind`: the member lies behind the edge where the pointer is, as a back edge seen edge on does. */
export function blendClickTarget(
  memberDist: number | null,
  edgeRankPx: number | null,
  radiusPx: number,
  memberBehind = false,
): BlendClickTarget {
  const m = memberDist != null && memberDist <= radiusPx ? memberDist : null;
  if (m != null && memberBehind && edgeRankPx != null && edgeRankPx <= m + COINCIDE_PX) return "edge";
  if (m != null && (edgeRankPx == null || m <= edgeRankPx + MEMBER_PREFERENCE_PX)) return "member";
  if (edgeRankPx != null) return "edge";
  return "none";
}

export function missPrompt(kind: "fillet" | "chamfer", members: number): string {
  return t("tool.fillet.miss", { n: members, kind });
}

/** A click on an edge or a face only the blend's result has: its rim, a seam it made, or its own round or flat. */
export function rimPrompt(kind: "fillet" | "chamfer", what: "edge" | "face" = "edge"): string {
  return `${t("pick.fromBlend", { what, kind })} · Esc`;
}
