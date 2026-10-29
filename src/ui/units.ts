// Display and input units. Geometry is always stored in mm; the setting only converts what the user sees and types.
// Angles are always degrees.

import { readSetting } from "./storedSetting";
// The display precision rule lives in ui/measure beside the parser; re-exported here so there is one import path.
import { roundForDisplay as displayRound } from "./measure";
export { displayRound };

export type Unit = "mm" | "cm" | "in";

const FACTOR: Record<Unit, number> = { mm: 1, cm: 10, in: 25.4 };
const KEY = "fundacad.unit";
const LEGACY_KEYS = ["neocad.unit", "sindricad.unit"];

let current: Unit = readStored();
const listeners = new Set<() => void>();

/** Every boundary feeding `current` must narrow here, not cast: the unit is interpolated raw into innerHTML in the
 *  properties and interference panels, so an unchecked value is a script injection path. */
export function asUnit(v: unknown): Unit | null {
  return v === "mm" || v === "cm" || v === "in" ? v : null;
}

function readStored(): Unit {
  const raw = readSetting(KEY, ...LEGACY_KEYS);
  return asUnit(raw) ?? "mm";
}

export function getUnit(): Unit {
  return current;
}

export function setUnit(u: Unit) {
  if (u === current) return;
  current = u;
  try {
    localStorage.setItem(KEY, u);
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn();
}

export function onUnitChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** mm -> current display unit */
export function toDisplay(mm: number): number {
  return mm / FACTOR[current];
}

/** current display unit -> mm */
export function fromDisplay(v: number): number {
  return v * FACTOR[current];
}

/** mm -> rounded display string with the unit suffix (e.g. "40 mm") */
export function fmtLength(mm: number): string {
  return `${displayRound(toDisplay(mm))} ${current}`;
}

const FRACTION_DENOMINATORS = [2, 4, 8, 16, 32, 64];

/** "1/16" for an inch length under one inch that is a whole number of 64ths, else null. */
function inchFraction(mm: number): string | null {
  const inches = mm / FACTOR.in;
  if (!(inches > 0 && inches < 1)) return null;
  for (const d of FRACTION_DENOMINATORS) {
    const n = Math.round(inches * d);
    if (n >= 1 && n < d && n % 2 === 1 && Math.abs(inches * d - n) < 1e-9 * d) return `${n}/${d}`;
  }
  return null;
}

/** At most three significant digits and no space, for the 40 px viewport grid button. Inch steps under one inch read
 *  as fractions. */
export function fmtLengthCompact(mm: number): string {
  const frac = current === "in" ? inchFraction(mm) : null;
  return frac ? `${frac}in` : `${Number(toDisplay(mm).toPrecision(3))}${current}`;
}

/** fmtLength for a grid step: inch steps under one inch read as fractions. */
export function fmtGridStep(mm: number): string {
  const frac = current === "in" ? inchFraction(mm) : null;
  return frac ? `${frac} in` : fmtLength(mm);
}

/** Quantise for storage to a thousandth, `snap()`'s lattice floor and the finest drag step (viewport/dragStep.ts).
 *  Display decimals are `displayRound`'s job. */
export function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Nearest "nice" step (1/2/5 × 10ⁿ) to a rough magnitude, used for the adaptive
 *  grid spacing and for snapping drag/cursor values to clean numbers. */
export function niceStep(rough: number): number {
  if (!(rough > 0) || !isFinite(rough)) return 1;
  const exp = Math.floor(Math.log10(rough));
  const base = rough / Math.pow(10, exp); // 1..10
  const nice = base < 1.5 ? 1 : base < 3.5 ? 2 : base < 7.5 ? 5 : 10;
  return nice * Math.pow(10, exp);
}

const INCH_FRACTION_STEPS = [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2];

/** Nearest inch grid step (by ratio) to a rough size in mm, returned in mm: 1/64 to 1/2 in by halving, then 1/2/5 in
 *  per decade, and decimal 1/2/5 steps below 1/64 in. */
export function niceInchStep(roughMm: number): number {
  if (!(roughMm > 0) || !isFinite(roughMm)) return FACTOR.in;
  const rough = roughMm / FACTOR.in;
  if (rough < INCH_FRACTION_STEPS[0]! / Math.SQRT2) return niceStep(rough) * FACTOR.in;
  const decade = Math.pow(10, Math.max(0, Math.floor(Math.log10(rough))));
  const candidates = [...INCH_FRACTION_STEPS, ...[1, 2, 5, 10].map((m) => m * decade)];
  let best = candidates[0]!;
  for (const c of candidates) if (Math.abs(Math.log(c / rough)) < Math.abs(Math.log(best / rough))) best = c;
  return best * FACTOR.in;
}

/** Grid spacing for a rough size in mm: inch steps while the display unit is inches, else the metric nice step. */
export function niceGridStep(roughMm: number): number {
  return current === "in" ? niceInchStep(roughMm) : niceStep(roughMm);
}

/** Minor cells per major grid line. Inch fractions take four, so the majors land on the next round fraction or whole
 *  inch (1/16 to 1/4, 1/4 to 1, 1/2 to 2 in). Whole inch steps run 1/2/5 per decade like metric and keep five. */
export function gridMajorEvery(stepMm: number): number {
  if (current !== "in") return 5;
  const inches = stepMm / FACTOR.in;
  return INCH_FRACTION_STEPS.some((f) => Math.abs(inches / f - 1) < 1e-9) ? 4 : 5;
}

/** Snap a value to a step, then strip float fuzz so it reads as a clean number
 *  (e.g. 0.30000001 → 0.3). */
export function snap(v: number, step: number): number {
  if (!(step > 0)) return round(v);
  return round(Math.round(v / step) * step);
}

// FieldKind lives in document/numFields.ts; re-exported for the input consumers that import it from here.
import type { FieldKind } from "../document/numFields";
export type { FieldKind };
import { canonicalTyping, tryParseMeasure, unitById } from "./measure";

/** numeric value to show in a field: angles stay in degrees, lengths convert */
export function displayValue(mm: number, kind: FieldKind = "length"): number {
  return kind === "length" ? displayRound(toDisplay(mm)) : displayRound(mm); // angle/count: raw
}

/** Parses through ui/measure, so every field takes units, symbols, compounds, fractions and arithmetic; a count takes
 *  arithmetic but no unit. Null if invalid. */
export function parseField(raw: string, kind: FieldKind = "length"): number | null {
  if (kind === "count") {
    const m = tryParseMeasure(raw, null);
    return m && !m.unit ? m.value : null;
  }
  const display = kind === "length" ? unitById(current) : unitById("deg");
  return tryParseMeasure(raw, display)?.value ?? null;
}

/** The unit a typed field named, so a surface can adopt it as its display unit. Null for a bare number. */
export function parsedUnit(raw: string, kind: FieldKind = "length"): string | null {
  if (kind === "count") return null;
  const display = kind === "length" ? unitById(current) : unitById("deg");
  return tryParseMeasure(raw, display)?.unit?.id ?? null;
}

/** A plain numeric literal (display-unit semantics at input surfaces) as
 *  opposed to an expression (canonical-unit semantics via the params engine).
 *  "5.0" and "-2e3" are plain; "5 mm", "width/2", "5+3" are expressions. */
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
export function isPlainNumber(raw: string): boolean {
  return plainNumber(raw) !== null;
}

/** The value of a plain literal, read the way ui/measure reads one: a decimal
 *  comma and a typographic minus are the same literal. Null for anything else,
 *  an ambiguous "1,000" included. */
export function plainNumber(raw: string): number | null {
  let src: string;
  try {
    src = canonicalTyping(raw);
  } catch {
    return null;
  }
  return PLAIN_NUMBER.test(src) ? Number(src) : null;
}
