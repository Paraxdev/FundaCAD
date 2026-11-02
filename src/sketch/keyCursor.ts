// Pure helpers for a cursor placed by keys rather than by a pointer.

import type * as THREE from "three";
import { niceGridStep } from "../ui/units";
import { MIN_SNAP_STEP } from "./planeGrid";
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

const RING_LIMIT = 16;

/** The snap candidates Tab walks: nearest first from `from`, one per spot (highest priority), none on `from` or `skip`. */
export function snapRing(
  from: THREE.Vector2,
  candidates: readonly SnapCandidate[],
  skip: readonly THREE.Vector2[],
  limit = RING_LIMIT,
): SnapCandidate[] {
  const kept: SnapCandidate[] = [];
  const byPriority = [...candidates].sort((a, b) => b.priority - a.priority);
  for (const c of byPriority) {
    if (c.p.distanceTo(from) <= COINCIDENT_MM || skip.some((s) => c.p.distanceTo(s) <= COINCIDENT_MM)) continue;
    if (kept.some((k) => k.p.distanceTo(c.p) <= COINCIDENT_MM)) continue;
    kept.push(c);
  }
  const dist = (c: SnapCandidate) => c.p.distanceTo(from);
  kept.sort((a, b) => {
    const d = dist(a) - dist(b);
    return Math.abs(d) > 1e-9 ? d : b.priority - a.priority || a.p.x - b.p.x || a.p.y - b.p.y;
  });
  return kept.slice(0, limit);
}

// Strips the float fuzz of a multiple (0.30000000000000004) without touching a lattice value such as 1/64 in.
const clean = (v: number) => Math.round(v * 1e9) / 1e9;

/** The next lattice line past `v` on one axis, so a value off the lattice lands on it and one on it moves a whole step. */
export function stepCoord(v: number, step: number, dir: 1 | -1): number {
  const k = v / step;
  return clean(dir === 1 ? (Math.floor(k + 1e-6) + 1) * step : (Math.ceil(k - 1e-6) - 1) * step);
}

export function fineStep(step: number): number {
  return Math.max(niceGridStep(step / 5), MIN_SNAP_STEP);
}

export function coarseStep(step: number): number {
  return niceGridStep(step * 5);
}
