/** A fillet's continuity with its faces. */
export type Continuity = "G1" | "G2" | "G3";

const LEVEL: Record<Continuity, number> = { G1: 1, G2: 2, G3: 3 };

/** G2 and G3 apply while an edge's curvature across it (`curvature` on a mesh edge, per mm, absent when 0) times
 *  the radius stays below this, the engine's own gate (FLAT_ACROSS in edge_curvature.hxx). */
export const FLAT_ACROSS = 1e-6;

export function continuityOf(v: unknown): Continuity {
  return v === "G2" || v === "G3" ? v : "G1";
}

/** The highest continuity every picked edge reaches at this radius: 3 while each is flat across, else 1. */
export function pickedReach(edges: readonly { curvature?: number }[], radius: number): number {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0;
  return edges.some((e) => (e.curvature ?? 0) * r >= FLAT_ACROSS) ? 1 : 3;
}

/** Why `c` cannot be picked on edges that reach `reach`, or null when it can. Worded as the engine's refusal. */
export function continuityBlocked(c: Continuity, reach: number): string | null {
  if (LEVEL[c] <= reach) return null;
  return `${c} needs both faces flat across the edge (planes, or a cylinder or cone met at a rim). An edge here runs along a curved face, use G1 there`;
}
