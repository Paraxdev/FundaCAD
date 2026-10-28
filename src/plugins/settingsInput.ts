import { parseMeasure, toUnit, unitById, type UnitDef } from "../ui/measure";
import { valueProblem, type NumberSetting } from "./settings";

/** The unit a bare number in this field means, null for a plain number. */
export function fieldUnit(p: NumberSetting, lengthUnit: string): UnitDef | null {
  if (p.unit === "length") return unitById(lengthUnit);
  if (p.unit === "angle") return unitById("deg");
  return null;
}

// The finest change roundForDisplay keeps at a shown size: hundredths from 1 up, two digits past the zeros below it.
function shownGrid(size: number): number {
  if (size >= 1) return 0.01;
  return size > 0 ? 10 ** -Math.min(6, 2 + Math.ceil(-Math.log10(size))) : 1e-6;
}

// roundForDisplay keeps a whole thousandth at any size.
const inThousandths = (v: number) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6;

/** How a number setting renders as a NumberField. A length or an angle is a unit the field converts, any other unit
 *  text a caption beside a plain number. The schema's step is in the stored unit, the field's in the shown one. */
export function numberField(
  p: NumberSetting,
  lengthUnit: string,
  value?: number,
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
  const factor = unit?.factor ?? 1;
  const perStep = step ? step / factor : 0;
  const reach = Math.max(
    0,
    ...[value, p.min, p.max].filter((v): v is number => Number.isFinite(v)).map((v) => Math.abs(v / factor)),
  );
  return {
    unit: unit?.id ?? null,
    caption: unit ? null : p.unit || null,
    // With nothing to step by the step is zero, so the arrows leave an in-range value alone. A step finer than the
    // text can show would leave the text where it was, so it moves one shown digit and parse puts it on the step.
    step: perStep && !inThousandths(perStep) ? Math.max(perStep, shownGrid(reach)) : perStep,
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
