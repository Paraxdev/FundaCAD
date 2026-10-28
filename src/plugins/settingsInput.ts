import { parseMeasure, toUnit, unitById, type UnitDef } from "../ui/measure";
import { valueProblem, type NumberSetting } from "./settings";

/** The unit a bare number in this field means, null for a plain number. */
export function fieldUnit(p: NumberSetting, lengthUnit: string): UnitDef | null {
  if (p.unit === "length") return unitById(lengthUnit);
  if (p.unit === "angle") return unitById("deg");
  return null;
}

/** How a number setting renders as a NumberField. A length or an angle is a unit the field converts, any other unit
 *  text a caption beside a plain number. The schema's step is in the stored unit, the field's in the shown one. */
export function numberField(
  p: NumberSetting,
  lengthUnit: string,
): {
  unit: string | null;
  caption: string | null;
  step: number;
  parse: (raw: string, unit: UnitDef | null) => number;
  validate: (v: number) => string | null;
} {
  const unit = fieldUnit(p, lengthUnit);
  const declared = p.step ?? (p.integer ? 1 : undefined);
  const step = declared && declared > 0 ? declared : null;
  const shown = (v: number, u: UnitDef | null) => String(toUnit(v, u));
  return {
    unit: unit?.id ?? null,
    caption: unit ? null : p.unit || null,
    // Zero keeps the arrow keys off a number with nothing to step by, as they always were.
    step: step ? step / (unit?.factor ?? 1) : 0,
    // The field steps and spells in the shown unit, rounded, so its own text for a step or a limit is read as that
    // exact value. Otherwise 5 mm stepped in inches would store 5.0038 and the max would refuse itself.
    parse: (raw, u) => {
      const v = parseMeasure(raw, u).value;
      const onStep = step ? Math.round(Math.round(v / step) * step * 1e9) / 1e9 : undefined;
      return [onStep, p.min, p.max].find((c) => c !== undefined && shown(c, u) === raw.trim()) ?? v;
    },
    validate: (v) => valueProblem(p, v),
  };
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
