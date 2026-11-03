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

interface Near {
  c: SnapCandidate;
  d: number;
}

const walkable = (c: SnapCandidate, from: THREE.Vector2, skip: readonly THREE.Vector2[]) =>
  c.p.distanceTo(from) > COINCIDENT_MM && !skip.some((s) => c.p.distanceTo(s) <= COINCIDENT_MM);

/** The snap candidates Tab walks: nearest first from `from`, one per spot (highest priority), none on `from` or `skip`. */
export function snapRing(
  from: THREE.Vector2,
  candidates: readonly SnapCandidate[],
  skip: readonly THREE.Vector2[],
  limit = RING_LIMIT,
): SnapCandidate[] {
  const order = (a: Near, b: Near) => {
    const d = a.d - b.d;
    return Math.abs(d) > 1e-9 ? d : b.c.priority - a.c.priority || a.c.p.x - b.c.p.x || a.c.p.y - b.c.p.y;
  };
  const near = candidates
    .filter((c) => walkable(c, from, skip))
    .map((c) => ({ c, d: c.p.distanceTo(from) }))
    .sort(order);
  // Nearest first and only `limit` kept, as a sketch with large projected polylines has tens of thousands of candidates.
  const kept: Near[] = [];
  for (const n of near) {
    const twin = kept.findIndex((k) => k.c.p.distanceTo(n.c.p) <= COINCIDENT_MM);
    if (twin >= 0) {
      if (n.c.priority > kept[twin]!.c.priority) kept[twin] = n;
    } else if (kept.length < limit) kept.push(n);
    else if (n.d - kept[kept.length - 1]!.d > COINCIDENT_MM) break;
  }
  return kept.sort(order).map((k) => k.c);
}

/** Whether snapRing has anything to walk, without building it. */
export function hasSnap(
  from: THREE.Vector2,
  candidates: readonly SnapCandidate[],
  skip: readonly THREE.Vector2[],
): boolean {
  return candidates.some((c) => walkable(c, from, skip));
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
