// What a click means in the Fillet / Chamfer tool once it has member edges:
// on a member (its ghost line) it drops that member, on another edge it adds
// it, and on anything else it does nothing to the feature. A miss used to
// commit the blend with whatever edges it had so far, which a near miss while
// adding the third of four corners turned into a part with two.

export interface ScreenPt {
  x: number;
  y: number;
}

/** Distance, in px, from `p` to a polyline drawn on screen, Infinity for no points. */
export function screenPolylineDist(pts: readonly ScreenPt[], p: ScreenPt): number {
  if (pts.length === 1) return Math.hypot(pts[0]!.x - p.x, pts[0]!.y - p.y);
  let best = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k]!, b = pts[k + 1]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y));
  }
  return best;
}

export type BlendClickTarget = "member" | "edge" | "none";

/** A member ranks this much nearer than a model edge. The edges right beside a
 *  member's line are mostly the blend's own preview (a chamfer's two new
 *  borders), which a click there never means, while an edge that runs on from
 *  the member's end is still preferred a few px along it. */
export const MEMBER_PREFERENCE_PX = 6;

/** Which of a member ghost and a model edge the pointer is on, each given as
 *  its screen distance (the edge's rank, picking.EdgeCandidate.rankPx) or null
 *  when none is in reach. */
export function blendClickTarget(memberDist: number | null, edgeRankPx: number | null, radiusPx: number): BlendClickTarget {
  const m = memberDist != null && memberDist <= radiusPx ? memberDist : null;
  if (m != null && (edgeRankPx == null || m <= edgeRankPx + MEMBER_PREFERENCE_PX)) return "member";
  if (edgeRankPx != null) return "edge";
  return "none";
}

/** The prompt for a click that found no edge: the tool stays open with its
 *  members, and says how to add one or finish. */
export function missPrompt(kind: "fillet" | "chamfer", members: number): string {
  const kept = `${members} edge${members === 1 ? "" : "s"} kept`;
  return `No edge there, ${kept} · click an edge to add it · Enter or ✓ to ${kind} · Esc`;
}
