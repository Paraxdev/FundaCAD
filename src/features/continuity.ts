/** A fillet's continuity with its faces. */
export type Continuity = "G1" | "G2" | "G3";

const LEVEL: Record<Continuity, number> = { G1: 1, G2: 2, G3: 3 };

/** G2 and G3 apply while an edge's curvature across it (`curvature` on a mesh edge, absent when 0) times the size
 *  stays below this, the engine's own gate (FLAT_ACROSS in edge_curvature.hxx). */
export const FLAT_ACROSS = 1e-6;

export function continuityOf(v: unknown): Continuity {
  return v === "G2" || v === "G3" ? v : "G1";
}

/** The highest continuity every picked edge reaches at this size: 3 while each is flat across, else 1. A chord is
 *  weighed against the curvature per mm of chord, since the build turns it into a larger radius on a shallow edge. */
export function pickedReach(
  edges: readonly { curvature?: readonly [number, number] }[],
  size: number,
  sizeType?: "radius" | "chord",
): number {
  const s = Number.isFinite(size) && size > 0 ? size : 0;
  const at = sizeType === "chord" ? 1 : 0;
  return edges.some((e) => (e.curvature?.[at] ?? 0) * s >= FLAT_ACROSS) ? 1 : 3;
}

/** Why `c` cannot be picked on edges that reach `reach`, or null when it can. Worded as the engine's refusal. */
export function continuityBlocked(c: Continuity, reach: number): string | null {
  if (LEVEL[c] <= reach) return null;
  return `${c} needs both faces flat across the edge (planes, or a cylinder or cone met at a rim). An edge here runs along a curved face, use G1 there`;
}
