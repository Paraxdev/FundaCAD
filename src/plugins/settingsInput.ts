import { unitById, type UnitDef } from "../ui/measure";
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
): { unit: string | null; caption: string | null; step: number | undefined; validate: (v: number) => string | null } {
  const unit = fieldUnit(p, lengthUnit);
  const step = p.step ?? (p.integer ? 1 : undefined);
  return {
    unit: unit?.id ?? null,
    caption: unit ? null : p.unit || null,
    step: step && step > 0 ? step / (unit?.factor ?? 1) : undefined,
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
