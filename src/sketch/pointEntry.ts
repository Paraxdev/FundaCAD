// Reads the X and Y fields of the sketch point box: absolute values, @dx,dy relative to the last placed point, and a
// pair typed into one field. A lone comma is split here, before measure.ts, which would read it as a decimal, but only
// in a language with a decimal point: with a decimal comma a pair takes a semicolon.

import { decimalMark, type DecimalMark } from "../i18n";
import { measureError, tryParseMeasure, type UnitDef } from "../ui/measure";

export interface PointTyping {
  x: string;
  y: string;
  xTyped: boolean;
  yTyped: boolean;
  // A field left alone is this value in mm, since its text went through the display rounding.
  at: { x: number; y: number };
}

export type PointRead = { ok: true; x: number; y: number } | { ok: false; field: "x" | "y"; problem: string };

type Field = "x" | "y";
type Part = { ok: true; value: number } | { ok: false; problem: string };

// 1.5 in times 25.4 is 38.099999999999994, and a typed point is meant to stay as typed.
const tidy = (v: number) => Math.round(v * 1e9) / 1e9;

// The kernel built a true solid at 1e7 mm and an empty body at 1e8, and tidy moves values past 9e6, so a point stops a safe step short.
export const POINT_LIMIT_MM = 1e6;
export const within = (v: number) => Math.abs(v) <= POINT_LIMIT_MM;
export const tooFar = (axis: "x" | "y") =>
  `${axis.toUpperCase()} is too far out, a point stays within 1 km of the origin`;

const SEMICOLON_HINT = "Write X;Y with a ; between the numbers when they have decimal commas";

function number(text: string, unit: UnitDef | null): Part {
  if (!text.trim()) return { ok: false, problem: "Type a number" };
  const m = tryParseMeasure(text, unit);
  if (m) return { ok: true, value: m.value };
  const problem = measureError(text, unit) ?? "Not a number";
  return { ok: false, problem: /unknown parameter/.test(problem) ? `"${text.trim()}" is not a number` : problem };
}

/** One value, or two split on a semicolon or, with a point mark, on the only comma. */
function split(body: string, mark: DecimalMark): { parts: string[] } | { problem: string } {
  if (body.includes(";")) {
    const parts = body.split(";");
    return parts.length === 2 ? { parts } : { problem: "Give two numbers at most, X then Y" };
  }
  if (mark === ",") return { parts: [body] };
  const commas = body.split(",").length - 1;
  if (commas === 0) return { parts: [body] };
  if (commas === 1) return { parts: body.split(",") };
  return { problem: SEMICOLON_HINT };
}

/** A lone comma before exactly three digits is a thousands mark nobody can be sure of, so it stays one number. */
const THREE_DIGITS_AFTER_COMMA = /,\d{3}$/;

function read(
  t: PointTyping,
  units: { x: UnitDef | null; y: UnitDef | null },
  from: { x: number; y: number },
  mark: DecimalMark,
): PointRead {
  const xText = t.xTyped ? t.x.trim() : null;
  const yText = t.yTyped ? t.y.trim() : null;
  const fail = (field: Field, problem: string): PointRead => ({ ok: false, field, problem });
  const rel = (field: Field, text: string): Part => {
    const s = split(text, mark);
    if ("problem" in s) return { ok: false, problem: s.problem };
    if (s.parts.length !== 1) return { ok: false, problem: "Give one number here" };
    return number(s.parts[0]!, units[field]);
  };
  const abs = (field: Field, text: string): Part => number(text, units[field]);

  // @dx,dy in X, or in Y while X is untouched: both axes, relative.
  const pairIn = (field: Field, text: string): PointRead | null => {
    const s = split(text.slice(1), mark);
    if ("problem" in s) return fail(field, s.problem);
    if (s.parts.length !== 2) return null;
    const dx = number(s.parts[0]!, units.x);
    if (!dx.ok) return fail(field, dx.problem);
    const dy = number(s.parts[1]!, units.y);
    if (!dy.ok) return fail(field, dy.problem);
    return { ok: true, x: from.x + dx.value, y: from.y + dy.value };
  };

  if (xText?.startsWith("@")) {
    const pair = pairIn("x", xText);
    if (pair) return pair;
    const dx = rel("x", xText.slice(1));
    if (!dx.ok) return fail("x", dx.problem);
    if (yText === null) return { ok: true, x: from.x + dx.value, y: from.y };
    if (yText.startsWith("@")) {
      const dy = rel("y", yText.slice(1));
      return dy.ok ? { ok: true, x: from.x + dx.value, y: from.y + dy.value } : fail("y", dy.problem);
    }
    const y = abs("y", yText);
    return y.ok ? { ok: true, x: from.x + dx.value, y: y.value } : fail("y", y.problem);
  }

  if (yText?.startsWith("@")) {
    if (xText === null) {
      const pair = pairIn("y", yText);
      if (pair) return pair;
    }
    const dy = rel("y", yText.slice(1));
    if (!dy.ok) return fail("y", dy.problem);
    if (xText === null) return { ok: true, x: from.x, y: from.y + dy.value };
    const x = abs("x", xText);
    return x.ok ? { ok: true, x: x.value, y: from.y + dy.value } : fail("x", x.problem);
  }

  if (xText !== null && yText === null) {
    const pairWanted =
      xText.includes(";") || (mark === "." && xText.includes(",") && !THREE_DIGITS_AFTER_COMMA.test(xText));
    if (pairWanted) {
      const s = split(xText, mark);
      if ("problem" in s) return fail("x", s.problem);
      if (s.parts.length === 2) {
        const x = abs("x", s.parts[0]!);
        if (!x.ok) return fail("x", x.problem);
        const y = number(s.parts[1]!, units.y);
        return y.ok ? { ok: true, x: x.value, y: y.value } : fail("x", y.problem);
      }
    }
  }

  let x: number;
  if (xText === null) x = t.at.x;
  else {
    const p = abs("x", xText);
    if (!p.ok) return fail("x", p.problem);
    x = p.value;
  }
  let y: number;
  if (yText === null) y = t.at.y;
  else {
    const p = abs("y", yText);
    if (!p.ok) return fail("y", p.problem);
    y = p.value;
  }
  return { ok: true, x, y };
}

export function readPoint(
  t: PointTyping,
  units: { x: UnitDef | null; y: UnitDef | null },
  from: { x: number; y: number },
): PointRead {
  const r = read(t, units, from, decimalMark());
  if (!r.ok) return r;
  // The field to mark is the one holding the text, as @dx,dy in X can put Y out of reach.
  if (!within(r.x)) return { ok: false, field: !t.xTyped && t.yTyped ? "y" : "x", problem: tooFar("x") };
  if (!within(r.y)) return { ok: false, field: !t.yTyped && t.xTyped ? "x" : "y", problem: tooFar("y") };
  return { ok: true, x: tidy(r.x), y: tidy(r.y) };
}
