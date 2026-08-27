// One place where a typed measurement becomes a number.
//
// Every value surface in the app reads through here: the heads-up field on a
// drag, the inspector rows, the sketch dimension boxes, the parameters table.
// They used to each call parseFloat, which meant "2mm" parsed as 2 in whatever
// the display unit happened to be, "1 inch" parsed as 1, and a fraction parsed
// as its first digit. All three are silent: you get a number, just not yours.
//
// What can be typed:
//
//   2            a bare number, in whatever unit the field is showing
//   2mm  2 mm    a unit, attached or spaced
//   1inch  2.5"  spelled out, abbreviated, or as a symbol
//   2'5"         compound, high unit first (feet and inches, metres and cm)
//   1/2"         a fraction
//   1 1/2 in     a mixed fraction
//   2mm+3cm      arithmetic across units
//   10x20        x reads as multiply, as it does on every drawing
//   width/2      a document parameter
//
// The arithmetic, the parameter references and the functions are the document's
// existing expression language (params/parse.ts) — this does NOT reimplement
// them. What it adds is the unit vocabulary and the notations that language has
// no room for: symbols, compounds and fractions. Those are normalised into an
// expression the existing parser already accepts, so there is one evaluator and
// one set of precedence rules.
//
// No dimensional analysis. "2mm * 3mm" is 6, not 6mm², exactly as the
// expression language has always behaved. Getting that right needs a type
// system on values, which is a bigger change than this and is not needed to
// stop the failures above.

import { ExprError, parseExpr } from "../params/parse";
import { evalNode } from "../params/eval";

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
  /** offered in the unit picker — the rest are input-only, so "thou" parses
   *  without putting a unit nobody asked for in front of everyone. */
  common?: boolean;
}

export const UNITS: UnitDef[] = [
  { id: "mm", label: "mm", dim: "length", factor: 1, common: true,
    aliases: ["mm", "millimeter", "millimeters", "millimetre", "millimetres"] },
  { id: "cm", label: "cm", dim: "length", factor: 10, common: true,
    aliases: ["cm", "centimeter", "centimeters", "centimetre", "centimetres"] },
  { id: "m", label: "m", dim: "length", factor: 1000, common: true,
    aliases: ["m", "meter", "meters", "metre", "metres"] },
  { id: "in", label: "in", dim: "length", factor: 25.4, common: true,
    aliases: ["in", "inch", "inches", '"', "″"] },
  { id: "ft", label: "ft", dim: "length", factor: 304.8, common: true,
    aliases: ["ft", "foot", "feet", "'", "′"] },
  { id: "um", label: "µm", dim: "length", factor: 0.001,
    aliases: ["um", "µm", "micron", "microns", "micrometer", "micrometers"] },
  { id: "thou", label: "thou", dim: "length", factor: 0.0254,
    aliases: ["thou", "mil", "mils"] },
  { id: "deg", label: "°", dim: "angle", factor: 1, common: true,
    aliases: ["deg", "degree", "degrees", "°"] },
  { id: "rad", label: "rad", dim: "angle", factor: 180 / Math.PI, common: true,
    aliases: ["rad", "radian", "radians"] },
];

const BY_ID = new Map(UNITS.map((u) => [u.id, u]));
/** Longest alias first, so "mm" is matched before "m" and "inches" before "in". */
const ALIASES: { text: string; unit: UnitDef }[] = UNITS
  .flatMap((unit) => unit.aliases.map((text) => ({ text, unit })))
  .sort((a, b) => b.text.length - a.text.length);

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
  /** the unit the user actually WROTE, or null for a bare number. This is what
   *  makes the field unit-agnostic: typing "1 inch" into a field showing mm
   *  means inches, and the field can adopt that as its display unit. */
  unit: UnitDef | null;
  /** true when the text was more than a literal — an expression, a compound or
   *  a fraction. Surfaces show these with an fx marker rather than editing them
   *  as a plain number. */
  derived: boolean;
}

// --- normalising the notations the expression language has no room for -------

const DIGIT = /[0-9]/;
/** Symbols that are units on their own. Kept out of the identifier scanner
 *  because none of them is a letter. */
const SYMBOLIC = new Set(["\"", "'", "″", "′", "°", "µ"]);

/** `1/2 in` and `1 1/2 in` — a fraction is a way of writing ONE value, not a
 *  term inside a formula, so it is only recognised when it is the whole input.
 *  Mixing it into arithmetic would make "1 1/2" ambiguous with "1 + 1/2" versus
 *  "1 * 1/2", and neither reading is obviously right. */
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

/** The number, if one starts at `i`. */
function matchNumberAt(src: string, i: number): { value: number; end: number } | null {
  let j = i;
  while (j < src.length && DIGIT.test(src[j]!)) j++;
  if (src[j] === ".") { j++; while (j < src.length && DIGIT.test(src[j]!)) j++; }
  if (j === i) return null;
  const value = Number(src.slice(i, j));
  return Number.isFinite(value) ? { value, end: j } : null;
}

interface Normalised {
  /** an expression the document's own parser accepts */
  expr: string;
  /** the first unit written, which is the one the value is "in" */
  unit: UnitDef | null;
  /** more than a bare literal */
  derived: boolean;
}

/** Rewrite the typed text into the expression language, folding every unit into
 *  the canonical one. A unit becomes a plain multiplication rather than a `mm`
 *  suffix so that feet, microns and thou — which the document language has no
 *  suffix for — travel the same path as millimetres. */
export function normalise(raw: string): Normalised {
  const src = raw.trim();
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
        derived: true,
      };
    }
  }

  let out = "";
  let unit: UnitDef | null = null;
  let derived = false;
  let terms = 0; // unit-suffixed groups emitted, for the compound rule
  let pendingJoin = false; // a group ended and nothing but space has followed
  let i = 0;

  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t") { i++; continue; }

    // `10x20` — x is multiply on every drawing ever printed. Only between two
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
      // A bare number sitting straight after a unit group is not a compound and
      // not arithmetic — `2"5` and `2mm 3` are half-finished thoughts. Joining
      // them silently (as concatenation, or as an implied +) would commit a
      // number the user never wrote.
      if (!u && pendingJoin) throw new ExprError(`put an operator between "${out}" and "${src.slice(i)}"`);
      if (u) {
        // Two unit groups with nothing between them is a compound: 2'5", 1m 20cm.
        if (pendingJoin) { out += "+"; derived = true; }
        out += String(num.value * u.unit.factor);
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
    // anything else — operators, parens, parameter names — is the expression
    // language's business, not ours
    out += ch;
    pendingJoin = false;
    derived = derived || !/[0-9.\s]/.test(ch);
    i++;

    // A unit may also follow a closed group: "(2+3)mm", "(width+1)in". The
    // language attaches suffixes to number literals only, so it becomes a
    // multiplication, which is what a unit has been all along here.
    if (ch === ")") {
      let j = i;
      while (src[j] === " ") j++;
      const u = matchUnitAt(src, j);
      if (u) {
        out += `*${u.unit.factor}`;
        if (!unit) unit = u.unit;
        derived = true;
        i = u.end;
      }
    }
  }

  if (terms > 1) derived = true;
  return { expr: out, unit, derived };
}

// --- the public entry point --------------------------------------------------

/** Read typed text as a measurement.
 *
 *  `displayUnit` is what a BARE number means — the unit the field is currently
 *  showing. A written unit always wins over it, which is the whole point: the
 *  field shows mm, you type "1 inch", you get an inch.
 *
 *  `params` is the document's parameter scope, so "width/2" resolves. Pass {}
 *  where there is none.
 *
 *  Throws ExprError with a message worth showing when the text is not a value.
 *  Returning null instead would put the caller in the position of inventing the
 *  reason, and "that is not a number" is never the interesting part. */
export function parseMeasure(
  raw: string,
  displayUnit: UnitDef | null,
  params: Record<string, number> = {},
): Measured {
  const n = normalise(raw);
  const value = evalNode(parseExpr(n.expr), params);
  if (!Number.isFinite(value)) throw new ExprError("that works out to nothing finite");
  // A bare number is in whatever the field is showing. A written unit has
  // already been folded into the canonical one by normalise().
  const scaled = n.unit ? value : value * (displayUnit?.factor ?? 1);
  return { value: scaled, unit: n.unit, derived: n.derived };
}

/** Same, but null instead of throwing — for the live path, where every
 *  keystroke passes through a half-typed value and an exception per character
 *  is not an error, it is the user still typing. */
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

/** The message to show for text that will not parse. */
export function measureError(raw: string, displayUnit: UnitDef | null, params: Record<string, number> = {}): string | null {
  try {
    parseMeasure(raw, displayUnit, params);
    return null;
  } catch (e) {
    return e instanceof Error && e.message ? e.message : "not a value";
  }
}

// --- showing one back --------------------------------------------------------

/** How many decimals a value is worth SHOWING at, and the one thing that earns
 *  more of them.
 *
 *  It used to be six, on the reasoning that six is past any tolerance the kernel
 *  works to and short of where doubles start lying. Both halves are true and the
 *  conclusion was still wrong: a field reading `24.098723` is not more precise
 *  than one reading `24.1`, it is less legible, and the four digits nobody asked
 *  for are the solver's arithmetic, not a decision anyone made.
 *
 *  So two places, and the exception that makes two places safe: a value that is
 *  ALREADY a three-decimal number is left alone. That is the signature of a
 *  number somebody chose — typed into a field, or landed on by a drag, which
 *  quantises to a nice 1/2/5 step (viewport/dragStep.ts) and so never arrives at
 *  1.375 by accident. Blunting those to 1.38 would be destroying information;
 *  blunting 24.098723 is discarding noise. Within float fuzz, because the length
 *  a sketch reports is usually a SUBTRACTION of two chosen numbers and
 *  10.123 - 3.377 does not land on 6.746 exactly.
 *
 *  Under 1mm two places is no longer rounding but erasure — 0.0523 would come
 *  back as 0.05 and 0.0012 as nothing at all — so below there the rule switches
 *  to three significant digits, still stopping at six places. */
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

/** Canonical value → "3.4 mm". `space` off gives "3.4mm" for tight chrome. */
export function formatMeasure(canonical: number, unit: UnitDef | null, space = true): string {
  const u = unit ?? BY_ID.get("mm")!;
  const n = toUnit(canonical, u);
  // Degrees read as 90° with nothing between; every other unit takes a space.
  const gap = space && u.label !== "°" ? " " : "";
  return `${n}${gap}${u.label}`;
}
