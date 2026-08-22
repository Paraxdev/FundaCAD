// Where a pattern's copies go.
//
// One arithmetic, used twice: the tool draws ghosts from it while you drag, and
// the sidecar builds the real solids from the same rule. The two MUST agree —
// a preview that shows five copies evenly spread and a build that produces four
// bunched at one end is worse than no preview at all, because it is believed.
// (sketch/pattern.ts makes the same argument for the 2D patterns, and this is
// the body-level twin of it; sidecar/builder.py's _pattern_linear and
// _pattern_circular are the other side.)
//
// No THREE and no viewport, so the rules can be pinned down in vitest rather
// than inferred from a screenshot.

import type { Axis3 } from "../types";

/** A pattern of nothing is not a pattern, and a pattern of one is the original.
 *  Both are legal to hold mid-gesture — you have to pass through 1 on the way to
 *  2 — and neither is legal to commit, which is a separate question. */
export const MIN_COUNT = 1;
/** The gesture's ceiling. Not a kernel limit: the kernel will happily union 400
 *  copies and take a minute over it, and a number reached by holding a key down
 *  is not a number anyone meant. Type one in the field to go higher. */
export const MAX_DRAG_COUNT = 100;

export function clampCount(n: number): number {
  if (!Number.isFinite(n)) return MIN_COUNT;
  return Math.max(MIN_COUNT, Math.min(MAX_DRAG_COUNT, Math.round(n)));
}

/** The unit vector of a named global axis. */
export function axisVector(axis: Axis3): [number, number, number] {
  return axis === "X" ? [1, 0, 0] : axis === "Y" ? [0, 1, 0] : [0, 0, 1];
}

/** Distance of each copy from the original, in mm. Copy 0 IS the original, so
 *  the first entry is always 0 — the pattern includes what it was made from,
 *  which is why a count of 3 at 20 mm reaches 40 mm and not 60. */
export function linearOffsets(count: number, spacing: number): number[] {
  const n = clampCount(count);
  const d = Number.isFinite(spacing) ? spacing : 0;
  const out: number[] = [];
  // Copy 0 is written as a literal 0 rather than 0*d, which on a negative
  // spacing is -0 — the same number, and a different one everywhere it is
  // printed or compared literally.
  for (let i = 0; i < n; i++) out.push(i === 0 ? 0 : i * d);
  return out;
}

/** True when a spread should be treated as the whole way round. */
export function isFullCircle(totalAngle: number): boolean {
  return Math.abs(Math.abs(totalAngle) - 360) < 1e-6;
}

/** The angle of each copy, in degrees, spanning `totalAngle`.
 *
 *  A full circle divides by the COUNT and a partial spread divides by the gaps
 *  between the copies — otherwise the last copy of a 360° pattern lands exactly
 *  on the first and the seam is doubled. Mirrors _pattern_circular; the rule is
 *  here rather than only there because it is the one thing about a circular
 *  pattern that is not obvious, and the ghost has to make the same choice. */
export function circularAngles(count: number, totalAngle: number): number[] {
  const n = clampCount(count);
  const total = Number.isFinite(totalAngle) ? totalAngle : 0;
  const step = isFullCircle(total) ? total / n : n > 1 ? total / (n - 1) : 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i === 0 ? 0 : i * step);
  return out;
}

/** What the prompt says about the pattern as it stands. Plain words, because it
 *  is read at a glance in the middle of a drag. */
export function describePattern(
  kind: "linear" | "circular",
  count: number,
  value: number,
  axis: Axis3,
): string {
  const n = clampCount(count);
  const copies = `${n} ${n === 1 ? "copy" : "copies"}`;
  if (kind === "linear") {
    return `${copies}, ${fmt(value)} mm apart along ${axis}`;
  }
  return `${copies} over ${fmt(value)}° about ${axis}`;
}

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "0";
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
