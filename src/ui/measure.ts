// Every value field reads typed measurements through here. Units, symbols, compounds (2'5"), fractions (1 1/2 in),
// `x` as multiply and parameters are normalised into the expression language of params/parse.ts, the one evaluator.
// No dimensional analysis: "2mm * 3mm" is 6.

import { ExprError, parseExpr } from "../params/parse";
import { evalNode } from "../params/eval";
import { commasToPoints, pointsToCommas } from "../params/decimalForm";
import { decimalMark, type DecimalMark } from "../i18n";

export type Dim = "length" | "angle";

export interface UnitDef {
  /** canonical id, and what is stored when a value overrides its display unit */
  id: string;
  /** what the user sees next to the number */
  label: string;
  dim: Dim;
  /** multiply by this to reach the canonical unit (mm for length, degrees for angle) */
  factor: number;
  /** everything that may be TYPED for it, lower-cased. Order does not matter;
   *  the scanner sorts by length so "mm" can never be eaten by "m". */
  aliases: string[];
  /** what a screen reader says, `short` when units are not spoken in full */
  spoken: { short: string; one: string; many: string };
  /** offered in the unit picker, the rest are input-only, so "thou" parses
   *  without putting a unit nobody asked for in front of everyone. */
  common?: boolean;
}

export const UNITS: UnitDef[] = [
  {
    id: "mm",
    label: "mm",
    spoken: { short: "mm", one: "millimetre", many: "millimetres" },
    dim: "length",
    factor: 1,
    common: true,
    aliases: ["mm", "millimeter", "millimeters", "millimetre", "millimetres"],
  },
  {
    id: "cm",
    label: "cm",
    spoken: { short: "cm", one: "centimetre", many: "centimetres" },
    dim: "length",
    factor: 10,
    common: true,
    aliases: ["cm", "centimeter", "centimeters", "centimetre", "centimetres"],
  },
  {
    id: "m",
    label: "m",
    spoken: { short: "m", one: "metre", many: "metres" },
    dim: "length",
    factor: 1000,
    common: true,
    aliases: ["m", "meter", "meters", "metre", "metres"],
  },
  {
    id: "in",
    label: "in",
    spoken: { short: "in", one: "inch", many: "inches" },
    dim: "length",
    factor: 25.4,
    common: true,
    aliases: ["in", "inch", "inches", '"', "″"],
  },
  {
    id: "ft",
    label: "ft",
    spoken: { short: "ft", one: "foot", many: "feet" },
    dim: "length",
    factor: 304.8,
    common: true,
    aliases: ["ft", "foot", "feet", "'", "′"],
  },
  {
    id: "um",
    label: "µm",
    spoken: { short: "µm", one: "micrometre", many: "micrometres" },
    dim: "length",
    factor: 0.001,
    aliases: ["um", "µm", "micron", "microns", "micrometer", "micrometers"],
  },
  {
    id: "thou",
    label: "thou",
    spoken: { short: "thou", one: "thou", many: "thou" },
    dim: "length",
    factor: 0.0254,
    aliases: ["thou", "mil", "mils"],
  },
  {
    id: "deg",
    label: "°",
    spoken: { short: "deg", one: "degree", many: "degrees" },
    dim: "angle",
    factor: 1,
    common: true,
    aliases: ["deg", "degree", "degrees", "°"],
  },
  {
    id: "rad",
    label: "rad",
    spoken: { short: "rad", one: "radian", many: "radians" },
    dim: "angle",
    factor: 180 / Math.PI,
    common: true,
    aliases: ["rad", "radian", "radians"],
  },
];

const BY_ID = new Map(UNITS.map((u) => [u.id, u]));

const SPOKEN_CAPTIONS: Record<string, { one: string; many: string }> = {
  "%": { one: "percent", many: "percent" },
  ms: { one: "millisecond", many: "milliseconds" },
  MPa: { one: "megapascal", many: "megapascals" },
  N: { one: "newton", many: "newtons" },
  "g/cm³": { one: "gram per cubic centimetre", many: "grams per cubic centimetre" },
};

/** A measure id or a caption as a screen reader says it, text it does not know comes back as written. */
export function spokenUnit(unit: string, full: boolean, one = false): string {
  const measure = BY_ID.get(unit)?.spoken;
  if (measure) return full ? (one ? measure.one : measure.many) : measure.short;
  const caption = Object.hasOwn(SPOKEN_CAPTIONS, unit) ? SPOKEN_CAPTIONS[unit] : null;
  return caption && full ? (one ? caption.one : caption.many) : unit;
}
/** Longest alias first, so "mm" is matched before "m" and "inches" before "in". */
const ALIASES: { text: string; unit: UnitDef }[] = UNITS.flatMap((unit) =>
  unit.aliases.map((text) => ({ text, unit })),
).sort((a, b) => b.text.length - a.text.length);

export function unitById(id: string | null | undefined): UnitDef | null {
  return (id && BY_ID.get(id)) || null;
}

/** Units offered in the picker, for one dimension. */
export function commonUnits(dim: Dim): UnitDef[] {
  return UNITS.filter((u) => u.common && u.dim === dim);
}

export interface Measured {
  /** canonical: mm for a length, degrees for an angle */
  value: number;
  /** The unit the user wrote, or null for a bare number; typing "1 inch" into a mm field means inches. */
  unit: UnitDef | null;
  /** More than a literal (an expression, compound or fraction); surfaces mark these fx rather than edit them. */
  derived: boolean;
}

const DIGIT = /[0-9]/;
/** Symbols that are units on their own. Kept out of the identifier scanner
 *  because none of them is a letter. */
const SYMBOLIC = new Set(['"', "'", "″", "′", "°", "µ"]);

/** A fraction is one value, recognised only as the whole input: inside arithmetic "1 1/2" is ambiguous. */
const FRACTION = /^([+-]?)\s*(?:(\d+)\s+)?(\d+)\s*\/\s*(\d+)\s*(.*)$/;

function matchUnitAt(src: string, i: number): { unit: UnitDef; end: number } | null {
  const rest = src.slice(i).toLowerCase();
  for (const a of ALIASES) {
    if (!rest.startsWith(a.text)) continue;
    // A letter alias must not be the head of a longer word: "2 minutes" is not
    // 2 metres, and "2 index" is not 2 inches.
    const after = src[i + a.text.length];
    if (/[a-z]/i.test(a.text[a.text.length - 1]!) && after && /[a-z0-9_]/i.test(after)) continue;
    return { unit: a.unit, end: i + a.text.length };
  }
  return null;
}

function matchNumberAt(src: string, i: number): { value: number; end: number } | null {
  let j = i;
  while (j < src.length && DIGIT.test(src[j]!)) j++;
  if (src[j] === ".") {
    j++;
    while (j < src.length && DIGIT.test(src[j]!)) j++;
  }
  if (j === i) return null;
  const value = Number(src.slice(i, j));
  return Number.isFinite(value) ? { value, end: j } : null;
}

interface Normalised {
  /** an expression the document's own parser accepts */
  expr: string;
  /** the first unit written, which is the one the value is "in" */
  unit: UnitDef | null;
  /** every unit written */
  units: UnitDef[];
  /** more than a bare literal */
  derived: boolean;
}

const TYPOGRAPHIC_MINUS = /[\u2212\u2012\u2013\uFE63\uFF0D]/g;
const DECIMAL_COMMA = /(\d),(\d+)/;

/** Locale minus signs and a decimal comma become ASCII. In a comma language every comma is the decimal mark, and a
 *  lone point before exactly three digits is refused, "1.500" could be fifteen hundred. With a point mark a comma is
 *  one only when it is the lone comma with no point or brackets, and never before exactly three digits, where "1,000"
 *  is refused rather than guessed. */
export function canonicalTyping(raw: string, mark: DecimalMark = decimalMark()): string {
  const src = raw.replace(TYPOGRAPHIC_MINUS, "-").trim();
  if (mark === ",") return commasToPoints(src);
  if (!src.includes(",") || src.includes("(") || src.includes(".")) return src;
  if (src.indexOf(",") !== src.lastIndexOf(",")) return src;
  const m = DECIMAL_COMMA.exec(src);
  if (!m) return src;
  if (m[2]!.length === 3) {
    throw new ExprError(`"${src}" is ambiguous, write a point for decimals or leave the comma out`);
  }
  return src.replace(DECIMAL_COMMA, "$1.$2");
}

/** A unit becomes a multiplication rather than a suffix, so feet, microns and thou, which the language has no suffix
 *  for, travel the same path as mm. */
export function normalise(raw: string): Normalised {
  const src = canonicalTyping(raw);
  if (!src) throw new ExprError("empty value");

  const frac = FRACTION.exec(src);
  if (frac) {
    const [, sign, whole, num, den, tail] = frac;
    const u = tail && tail.trim() ? matchUnitAt(tail.trim(), 0) : null;
    if (!tail || !tail.trim() || (u && u.end === tail.trim().length)) {
      const v = (whole ? Number(whole) : 0) + Number(num) / Number(den);
      const f = u ? u.unit.factor : 1;
      return {
        expr: `${sign === "-" ? "-" : ""}${v * f}`,
        unit: u?.unit ?? null,
        units: u ? [u.unit] : [],
        derived: true,
      };
    }
  }

  let out = "";
  let unit: UnitDef | null = null;
  const units: UnitDef[] = [];
  let derived = false;
  let terms = 0; // unit-suffixed groups emitted, for the compound rule
  let pendingJoin = false; // a group ended and nothing but space has followed
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }

    // `10x20`, x is multiply on every drawing ever printed. Only between two
    // numbers, so a parameter called `x` is untouched.
    if (ch === "x" || ch === "X" || ch === "×") {
      let k = i + 1;
      while (src[k] === " ") k++;
      if (/[0-9)]\s*$/.test(out) && matchNumberAt(src, k)) {
        out += "*";
        derived = true;
        pendingJoin = false;
        i = k;
        continue;
      }
    }

    const num = matchNumberAt(src, i);
    if (num) {
      let j = num.end;
      while (src[j] === " ") j++;
      const u = matchUnitAt(src, j);
      // A bare number right after a unit group (`2"5`, `2mm 3`) is half finished; joining it would invent a number.
      if (!u && pendingJoin) throw new ExprError(`put an operator between "${out}" and "${src.slice(i)}"`);
      if (u) {
        // Two unit groups with nothing between them is a compound: 2'5", 1m 20cm.
        if (pendingJoin) {
          out += "+";
          derived = true;
        }
        out += String(num.value * u.unit.factor);
        units.push(u.unit);
        if (!unit) unit = u.unit;
        else if (u.unit !== unit) derived = true;
        terms++;
        pendingJoin = true;
        i = u.end;
        continue;
      }
      out += src.slice(i, num.end);
      pendingJoin = false;
      i = num.end;
      continue;
    }

    if (SYMBOLIC.has(ch)) throw new ExprError(`"${ch}" needs a number in front of it`);
    // anything else, operators, parens, parameter names, is the expression
    // language's business, not ours
    out += ch;
    pendingJoin = false;
    derived = derived || !/[0-9.\s]/.test(ch);
    i++;

    // A unit after a closed group, "(2+3)mm": the language suffixes only literals, so it becomes a multiplication.
    if (ch === ")") {
      let j = i;
      while (src[j] === " ") j++;
      const u = matchUnitAt(src, j);
      if (u) {
        out += `*${u.unit.factor}`;
        units.push(u.unit);
        if (!unit) unit = u.unit;
        derived = true;
        i = u.end;
      }
    }
  }

  if (terms > 1) derived = true;
  return { expr: out, unit, units, derived };
}

/** `displayUnit` is what a bare number means, a written unit always wins. `params` resolves "width/2", {} for none.
 *  Throws ExprError with a message worth showing, so callers do not invent the reason. */
export function parseMeasure(raw: string, displayUnit: UnitDef | null, params: Record<string, number> = {}): Measured {
  const n = normalise(raw);
  const value = evalNode(parseExpr(n.expr), params);
  if (!Number.isFinite(value)) throw new ExprError("that works out to nothing finite");
  // A bare number is in whatever the field is showing. A written unit has
  // already been folded into the canonical one by normalise().
  const scaled = n.unit ? value : value * (displayUnit?.factor ?? 1);
  return { value: scaled, unit: n.unit, derived: n.derived };
}

/** Null instead of throwing, for the live path where a half-typed value is the user still typing. */
export function tryParseMeasure(
  raw: string,
  displayUnit: UnitDef | null,
  params: Record<string, number> = {},
): Measured | null {
  try {
    return parseMeasure(raw, displayUnit, params);
  } catch {
    return null;
  }
}

export function measureError(
  raw: string,
  displayUnit: UnitDef | null,
  params: Record<string, number> = {},
): string | null {
  try {
    parseMeasure(raw, displayUnit, params);
    return null;
  } catch (e) {
    return e instanceof Error && e.message ? e.message : "not a value";
  }
}

const DIM_WORD: Record<Dim, string> = { length: "a length", angle: "an angle" };

/** A NumberField `parse` for one kind of value, null for a plain count: fractions, a comma and arithmetic read as ever,
 *  and a written unit of another kind is refused, since folding it would turn "1 in" into 25.4 degrees. */
export function readAs(dim: Dim | null): (raw: string) => number {
  return (raw) => {
    const wrong = normalise(raw).units.find((u) => u.dim !== dim);
    if (wrong) throw new ExprError(`This takes ${dim ? DIM_WORD[dim] : "a plain number"}, not ${wrong.label}`);
    return parseMeasure(raw, null).value;
  };
}

/** A drop-in for `Number.parseFloat`: NaN for blank or unparseable text, a written unit folded into mm or degrees. */
export function fieldNumber(raw: string): number {
  return tryParseMeasure(raw, null)?.value ?? Number.NaN;
}

/** Blank is not an error, the form has its own fallback. */
export function fieldError(raw: string): string | null {
  return raw.trim() === "" ? null : measureError(raw, null);
}

/** Two decimals, except a value already on three decimals within float fuzz (typed, or a drag's 1/2/5 step) is kept,
 *  and under 1mm it switches to three significant digits, up to six places, so small values are not erased. */
export function roundForDisplay(v: number): number {
  if (!Number.isFinite(v)) return v;
  const chosen = Math.round(v * 1e3) / 1e3;
  if (Math.abs(v - chosen) <= 1e-9 * Math.max(1, Math.abs(v))) return chosen;
  const a = Math.abs(v);
  if (a >= 1) return Math.round(v * 100) / 100;
  const dp = Math.min(6, 2 + Math.ceil(-Math.log10(a)));
  const f = Math.pow(10, dp);
  return Math.round(v * f) / f;
}

/** Canonical value → the number to put in a field showing `unit`. */
export function toUnit(canonical: number, unit: UnitDef | null): number {
  return roundForDisplay(canonical / (unit?.factor ?? 1));
}

/** The number as a box shows it: String(n) with the point swapped for the language's mark. */
export function spellNumber(n: number, mark: DecimalMark = decimalMark()): string {
  const text = String(n);
  return mark === "," ? text.replace(".", ",") : text;
}

/** Typed expression text as the stored point grammar. In a dot language it is untouched, so a comma there is
 *  refused by the tokenizer as before. In a comma language it throws ExprError for a number it will not guess, such
 *  as 1.500; `typedExprProblem` says so without throwing. */
export function storedExpr(typed: string, mark: DecimalMark = decimalMark()): string {
  return mark === "," ? commasToPoints(typed) : typed;
}

/** Why storedExpr refuses typed expression text, null when it takes it. */
export function typedExprProblem(typed: string, mark: DecimalMark = decimalMark()): string | null {
  try {
    storedExpr(typed, mark);
    return null;
  } catch (e) {
    if (e instanceof ExprError) return e.message;
    throw e;
  }
}

/** Stored expression text as the language shows it, the reverse of storedExpr. */
export function shownExpr(stored: string, mark: DecimalMark = decimalMark()): string {
  return mark === "," ? pointsToCommas(stored) : stored;
}

/** `toFixed` with the language's mark, trailing zeros kept. */
export function spellFixed(v: number, digits: number, mark: DecimalMark = decimalMark()): string {
  const text = v.toFixed(digits);
  return mark === "," ? text.replace(".", ",") : text;
}

export function spellRounded(v: number, mark?: DecimalMark): string {
  return spellNumber(roundForDisplay(v), mark);
}

/** A comma mark cannot also separate list items, so comma languages join with a semicolon. */
export function listJoin(parts: readonly string[], mark: DecimalMark = decimalMark()): string {
  return parts.join(mark === "," ? "; " : ", ");
}

/** Canonical value → "3.4 mm". `space` off gives "3.4mm" for tight chrome. */
export function formatMeasure(canonical: number, unit: UnitDef | null, space = true): string {
  const u = unit ?? BY_ID.get("mm")!;
  const n = spellNumber(toUnit(canonical, u));
  // Degrees read as 90° with nothing between; every other unit takes a space.
  const gap = space && u.label !== "°" ? " " : "";
  return `${n}${gap}${u.label}`;
}
