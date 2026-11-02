// Pure helpers for a cursor placed by keys rather than by a pointer.

import type * as THREE from "three";
import type { SnapCandidate } from "./snap";

// The solver's coincidence bucket, so a typed point that lands this close counts as that anchor.
export const COINCIDENT_MM = 1e-3;

/** The highest priority candidate within COINCIDENT_MM of `p`, else null. */
export function hitAt(p: THREE.Vector2, candidates: readonly SnapCandidate[]): SnapCandidate | null {
  let best: SnapCandidate | null = null;
  for (const c of candidates) {
    if (c.p.distanceTo(p) > COINCIDENT_MM) continue;
    if (!best || c.priority > best.priority) best = c;
  }
  return best;
}
