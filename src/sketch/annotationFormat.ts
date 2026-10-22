// Text, classes and tooltips of the sketch dim badges and constraint glyphs, computed once per sketch rebuild.
// Badge position changes every camera frame and is written by a rAF loop; screenTransform is its testable part.

import { displayValue, fmtLength, isPlainNumber } from "../ui/units";
import type { ConstraintDiagnosis } from "./glyphs";

export type DimKind = "length" | "angle";

/** Length in the display unit, angle in degrees; driven dims in brackets, param driven ones get fx:. */
export function fmtDim(
  mm: number,
  kind?: DimKind | undefined,
  driven?: boolean | undefined,
  fx?: boolean | undefined,
): string {
  const s = kind === "angle" ? `${displayValue(mm, "angle")}°` : fmtLength(mm);
  return driven ? `(${s})` : fx ? `fx: ${s}` : s;
}

/** A real formula, not a bare literal, earns the `fx:` prefix, and a click reopens the expression. */
export function isFormula(expr?: string | undefined): boolean {
  return !!expr && !isPlainNumber(expr);
}

/** Conflict wins over over-defined, as in diagnosisOf() in glyphs.ts, so the two layers agree on red vs amber.
 *  `| undefined` on each field is for exactOptionalPropertyTypes, so callers can forward optional flags. */
export function dimClass(d: {
  driven?: boolean | undefined;
  fx?: boolean | undefined;
  conflict?: boolean | undefined;
  over?: boolean | undefined;
}): string {
  const cls = ["sketch-dim"];
  if (d.driven) cls.push("sketch-dim-driven");
  if (d.fx) cls.push("sketch-dim-fx");
  if (d.conflict) cls.push("conflict");
  else if (d.over) cls.push("over");
  return cls.join(" ");
}

export function dimTitle(d: {
  driven?: boolean | undefined;
  fx?: boolean | undefined;
  expr?: string | undefined;
}): string {
  if (d.driven) return "Reference dimension (measured, not driving)";
  return d.fx ? `= ${d.expr} · click to edit` : "Click to edit, drag to move";
}

export function glyphClass(st: ConstraintDiagnosis | null): string {
  return st ? `sketch-glyph ${st}` : "sketch-glyph";
}

export function glyphTitle(st: ConstraintDiagnosis | null): string {
  return st === "conflict"
    ? "Conflicting constraint, click to delete"
    : st === "over"
      ? "Redundant (over-defined) constraint, click to delete"
      : "Click to delete this constraint";
}

/** The -50% centring stays in the transform, not the stylesheet: this translate overwrites the whole property. */
export function screenTransform(x: number, y: number): string {
  return `translate(${x}px, ${y}px) translate(-50%, -50%)`;
}
