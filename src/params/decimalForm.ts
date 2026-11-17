// A decimal comma typed in a language that writes one, turned into the point the grammar of parse.ts reads. The swap
// keeps the length, so error positions stay right.

import { ExprError, tokenize } from "./parse";

const DIGIT = /[0-9]/;
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
// "10x2,5" and "10x,5" are the drawing form of 10 times 2,5 and 0,5 that ui/measure reads; the x is not the start of a
// name there.
const isTimesX = (text: string, i: number) =>
  (text[i] === "x" || text[i] === "X") &&
  /[0-9)]/.test(text[i - 1] ?? "") &&
  (DIGIT.test(text[i + 1] ?? "") || (/[,.]/.test(text[i + 1] ?? "") && DIGIT.test(text[i + 2] ?? "")));
// "1.500" could be a thousands point, the mirror of "1,000" in a point language. After a zero whole part (0.250) or
// with an exponent it never is.
const POINT_BEFORE_THREE = /^0*[1-9][0-9]*\.[0-9]{3}$/;
const EXPONENT = /^[eE][+-]?[0-9]/;

/** A comma is a decimal mark when a digit follows it and it starts a number or continues one. After a name or a
 *  closing bracket it stays, so the tokenizer refuses it. A doubtful number (1,5,5) becomes one the grammar refuses.
 *  A lone point before exactly three digits after a nonzero whole part (1.500, not 0.250) throws ExprError, refused
 *  rather than guessed. */
export function commasToPoints(text: string): string {
  return swapMark(text, ",", ".");
}

// The one scan both directions share, so what pointsToCommas shows commasToPoints reads back. Going to a point it
// refuses a doubtful point (1.500); going to a comma it never refuses.
function swapMark(text: string, from: "," | ".", to: "," | "."): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (isTimesX(text, i)) {
      out += ch;
      i++;
      if (text[i] === from) {
        out += to;
        i++;
      }
    } else if (IDENT_START.test(ch)) {
      let j = i + 1;
      while (j < text.length && IDENT_PART.test(text[j]!)) j++;
      out += text.slice(i, j);
      i = j;
    } else if (DIGIT.test(ch)) {
      let j = i + 1;
      for (;;) {
        while (j < text.length && DIGIT.test(text[j]!)) j++;
        if ((text[j] === "," || text[j] === ".") && DIGIT.test(text[j + 1] ?? "")) j++;
        else break;
      }
      const num = text.slice(i, j);
      if (to === "." && POINT_BEFORE_THREE.test(num) && !EXPONENT.test(text.slice(j))) {
        throw new ExprError(`"${num}" is ambiguous, write a comma for decimals or leave the point out`, i);
      }
      out += num.split(from).join(to);
      i = j;
    } else if (ch === from && DIGIT.test(text[i + 1] ?? "") && !/[A-Za-z0-9_)]/.test(text[i - 1] ?? "")) {
      out += to;
      i++;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Stored point text with the point of each number shown as a comma. A point with no digit after it (5. or 5.e3)
 *  stays, because a comma there would not read back. Text the tokenizer refuses (22.125°, 10x2.500) is swapped by the
 *  scan commasToPoints reads, so it commits back unchanged. */
export function pointsToCommas(stored: string): string {
  let tokens;
  try {
    tokens = tokenize(stored);
  } catch (e) {
    if (!(e instanceof ExprError)) throw e;
    return swapMark(stored, ".", ",");
  }
  let out = "";
  let at = 0;
  for (const t of tokens) {
    if (t.kind !== "num") continue;
    out += stored.slice(at, t.start) + stored.slice(t.start, t.end).replace(/\.(?=[0-9])/, ",");
    at = t.end;
  }
  return out + stored.slice(at);
}
