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
