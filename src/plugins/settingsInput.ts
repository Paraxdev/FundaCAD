// Typed text and key presses turned into setting values, for the settings form.

import { measureError, parseMeasure, toUnit, unitById, type UnitDef } from "../ui/measure";
import { valueProblem, type NumberSetting } from "./settings";

/** The unit a bare number in this field means, null for a plain number. */
export function fieldUnit(p: NumberSetting, lengthUnit: string): UnitDef | null {
  if (p.unit === "length") return unitById(lengthUnit);
  if (p.unit === "angle") return unitById("deg");
  return null;
}

/** The stored number as the field shows it. */
export function numberText(p: NumberSetting, v: number, lengthUnit: string): string {
  return String(toUnit(v, fieldUnit(p, lengthUnit)));
}

/** What a unit suffix beside the field says. */
export function unitLabel(p: NumberSetting, lengthUnit: string): string {
  return fieldUnit(p, lengthUnit)?.label ?? p.unit ?? "";
}

/** Typed text read through the app's measure grammar, then the property's own
 *  limits, so "1 in" works in a length and "abc" says why it does not. */
export function parseNumberField(
  p: NumberSetting,
  raw: string,
  lengthUnit: string,
): { value: number } | { error: string } {
  const unit = fieldUnit(p, lengthUnit);
  const bad = raw.trim() === "" ? "type a value" : measureError(raw, unit);
  if (bad) return { error: bad };
  const value = parseMeasure(raw, unit).value;
  const problem = valueProblem(p, value);
  if (!problem) return { value };
  const shown = (n: number) => `${toUnit(n, unit)}${unit ? ` ${unit.label}` : ""}`;
  if (p.min !== undefined && value < p.min) return { error: `at least ${shown(p.min)}` };
  if (p.max !== undefined && value > p.max) return { error: `at most ${shown(p.max)}` };
  return { error: problem };
}

/** The value an arrow key moves a number to: `times` steps of its declared
 *  step (1 for an integer without one), onto the step grid and inside its
 *  limits. Null when the property declares nothing to step by. */
export function stepNumber(p: NumberSetting, v: number, times: number): number | null {
  const step = p.step ?? (p.integer ? 1 : undefined);
  if (!step || !(step > 0)) return null;
  // Rounded to 1e-9 so 0.1 steps read back as 0.3, not 0.30000000000000004.
  let next = Math.round((Math.round(v / step) + times) * step * 1e9) / 1e9;
  if (p.min !== undefined) next = Math.max(p.min, next);
  if (p.max !== undefined) next = Math.min(p.max, next);
  return p.integer ? Math.round(next) : next;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/** A key press written the way the shortcut sheet writes one, "Ctrl+Shift+K",
 *  or null while only modifiers are held. */
export function keyCombo(ev: {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): string | null {
  if (MODIFIER_KEYS.has(ev.key)) return null;
  const name = ev.key === " " ? "Space" : ev.key.replace(/^Arrow/, "");
  const key = name.length === 1 ? name.toUpperCase() : name;
  return `${ev.ctrlKey || ev.metaKey ? "Ctrl+" : ""}${ev.altKey ? "Alt+" : ""}${ev.shiftKey ? "Shift+" : ""}${key}`;
}
