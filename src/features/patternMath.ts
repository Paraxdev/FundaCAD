// Where a pattern's copies go. The engine builds from the same rule (builder.py _pattern_linear and
// _pattern_circular), and a ghost that disagrees with the build is worse than none because it is believed.

import type { Axis3 } from "../types";

/** 1 is legal mid-gesture, on the way to 2, but not to commit. */
export const MIN_COUNT = 1;
/** The gesture's ceiling, not a kernel limit: the kernel unions 400 copies but takes about a minute, and a count
 *  reached by holding a key down is not one anyone meant. Type a value in the field to go higher. */
export const MAX_DRAG_COUNT = 100;

export function clampCount(n: number): number {
  if (!Number.isFinite(n)) return MIN_COUNT;
  return Math.max(MIN_COUNT, Math.min(MAX_DRAG_COUNT, Math.round(n)));
}

export function axisVector(axis: Axis3): [number, number, number] {
  return axis === "X" ? [1, 0, 0] : axis === "Y" ? [0, 1, 0] : [0, 0, 1];
}

/** In mm. Copy 0 is the original, so a count of 3 at 20 mm reaches 40 mm, not 60. */
export function linearOffsets(count: number, spacing: number): number[] {
  const n = clampCount(count);
  const d = Number.isFinite(spacing) ? spacing : 0;
  const out: number[] = [];
  // A literal 0 for copy 0: 0*d on a negative spacing is -0, which prints and compares differently.
  for (let i = 0; i < n; i++) out.push(i === 0 ? 0 : i * d);
  return out;
}

export function isFullCircle(totalAngle: number): boolean {
  return Math.abs(Math.abs(totalAngle) - 360) < 1e-6;
}

/** In degrees. A full circle divides by the count and a partial spread by the gaps, or a 360° pattern doubles
 *  its seam. Mirrors _pattern_circular. */
export function circularAngles(count: number, totalAngle: number): number[] {
  const n = clampCount(count);
  const total = Number.isFinite(totalAngle) ? totalAngle : 0;
  const step = isFullCircle(total) ? total / n : n > 1 ? total / (n - 1) : 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(i === 0 ? 0 : i * step);
  return out;
}

export function describePattern(kind: "linear" | "circular", count: number, value: number, axis: Axis3): string {
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
