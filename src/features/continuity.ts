/** A fillet's continuity with its faces. The engine reports per edge the highest one its section build reaches
 *  (`reach` on a mesh edge, absent means 3), since only it knows the faces' curvature. */
export type Continuity = "G1" | "G2" | "G3";

const LEVEL: Record<Continuity, number> = { G1: 1, G2: 2, G3: 3 };

export function continuityOf(v: unknown): Continuity {
  return v === "G2" || v === "G3" ? v : "G1";
}

/** The highest continuity every picked edge reaches. */
export function pickedReach(edges: readonly { reach?: number }[]): number {
  return edges.reduce((m, e) => Math.min(m, e.reach ?? 3), 3);
}

/** Why `c` cannot be picked on edges that reach `reach`, or null when it can. Worded as the engine's refusal. */
export function continuityBlocked(c: Continuity, reach: number): string | null {
  if (LEVEL[c] <= reach) return null;
  return `${c} needs both faces flat across the edge (planes, or a cylinder or cone met at a rim). An edge here runs along a curved face, use G1 there`;
}
