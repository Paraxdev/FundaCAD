// Presentation of the two in-canvas sketch annotation layers, dimension badges
// and constraint glyphs, as pure functions of a badge's state.
//
// Extracted when sketchDimensions.ts / sketchGlyphs.ts handed their DOM to
// components/overlays/Sketch{Dim,Glyph}Layer.vue. The split is deliberate: the
// text, class list and tooltip of a badge only ever change when the sketch is
// rebuilt, so they are computed once, here, and rendered declaratively. Where a
// badge SITS changes every frame the camera moves and is written straight onto
// the element by a rAF loop, screenTransform() below is the only part of that
// path a test can reach, because happy-dom has no layout and no WebGL camera.

import { displayValue, fmtLength, isPlainNumber } from "../ui/units";
import type { ConstraintDiagnosis } from "./glyphs";

export type DimKind = "length" | "angle";

/** format a dim value for display: length in the display unit, angle in degrees;
 *  driven (reference) dims are wrapped in brackets, param-driven get fx:. */
export function fmtDim(
  mm: number,
  kind?: DimKind | undefined,
  driven?: boolean | undefined,
  fx?: boolean | undefined,
): string {
  const s = kind === "angle" ? `${displayValue(mm, "angle")}°` : fmtLength(mm);
  return driven ? `(${s})` : fx ? `fx: ${s}` : s;
}

/** True when a dim's driving expression is a real formula rather than a bare
 *  literal, that is what earns the `fx:` prefix and reopens the EXPRESSION
 *  (not the value) when the label is clicked. */
export function isFormula(expr?: string | undefined): boolean {
  return !!expr && !isPlainNumber(expr);
}

/** conflict beats over-defined, matching diagnosisOf() in glyphs.ts, the two
 *  layers must never disagree about red vs amber.
 *
 *  The `| undefined` on every field is not noise: the project runs with
 *  exactOptionalPropertyTypes, so without it a caller cannot forward an
 *  already-optional flag through. */
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

/** A projected badge's position, as a `transform` value. Both layers centre
 *  themselves on the projected point, and the -50% pair has to stay in the
 *  transform (not in the stylesheet) because the translate that precedes it
 *  overwrites the whole property. */
export function screenTransform(x: number, y: number): string {
  return `translate(${x}px, ${y}px) translate(-50%, -50%)`;
}
