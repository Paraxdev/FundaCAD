// Expression evaluation in canonical units (mm, degrees, counts). Arithmetic never throws (x/0 is Infinity) and
// callers gate on Number.isFinite; structural problems (unknown name or function, wrong arity) throw ExprError.

import { CONSTANTS, ExprRefusal, FUNCTIONS, RESERVED_FUNCTIONS, parseExpr } from "./parse";
import type { BinOp, ExprNode } from "./parse";

const TRUTH_OPS = new Set<BinOp>(["<", "<=", ">", ">=", "==", "!=", "&&", "||"]);

export function evalNode(n: ExprNode, values: Record<string, number>): number {
  switch (n.t) {
    case "num":
      return n.v;
    case "ref": {
      if (n.name in values) return values[n.name]!;
      if (n.name in CONSTANTS) return CONSTANTS[n.name]!;
      throw new ExprRefusal("field.problem.unknownName", { name: n.name });
    }
    case "call": {
      const fn = FUNCTIONS[n.name];
      if (!fn) {
        throw new ExprRefusal(RESERVED_FUNCTIONS.has(n.name) ? "expr.notYet" : "expr.unknownFunction", {
          name: n.name,
        });
      }
      const [lo, hi] = fn.arity;
      if (n.args.length < lo || n.args.length > hi) {
        const form = hi === Infinity ? "atLeast" : lo !== hi ? "range" : lo === 1 ? "one" : "other";
        throw new ExprRefusal("expr.arity", { name: n.name, form, lo, hi: hi === Infinity ? lo : hi });
      }
      return fn.apply(n.args.map((a) => evalNode(a, values)));
    }
    case "bin": {
      const l = evalNode(n.l, values);
      const r = evalNode(n.r, values);
      // NaN poisons comparison and logic too, so a broken input never reads as
      // a clean false and switches a feature off without anyone noticing.
      if (TRUTH_OPS.has(n.op) && (Number.isNaN(l) || Number.isNaN(r))) return NaN;
      switch (n.op) {
        case "+":
          return l + r;
        case "-":
          return l - r;
        case "*":
          return l * r;
        case "/":
          return l / r;
        case "^":
          return Math.pow(l, r);
        case "<":
          return l < r ? 1 : 0;
        case "<=":
          return l <= r || nearlyEqual(l, r) ? 1 : 0;
        case ">":
          return l > r ? 1 : 0;
        case ">=":
          return l >= r || nearlyEqual(l, r) ? 1 : 0;
        case "==":
          return nearlyEqual(l, r) ? 1 : 0;
        case "!=":
          return nearlyEqual(l, r) ? 0 : 1;
        case "&&":
          return l !== 0 && r !== 0 ? 1 : 0;
        case "||":
          return l !== 0 || r !== 0 ? 1 : 0;
      }
    }
    // eslint-disable-next-line no-fallthrough -- the inner switch returns on every op
    case "neg":
      return -evalNode(n.e, values);
    case "not": {
      const v = evalNode(n.e, values);
      return Number.isNaN(v) ? NaN : v === 0 ? 1 : 0;
    }
  }
}

export function nearlyEqual(a: number, b: number): boolean {
  if (a === b) return true;
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/** Parse + evaluate `src` against `values`. Throws ExprError on structural
 *  errors; may return a non-finite number (caller decides what that means). */
export function evalExpr(src: string, values: Record<string, number>): number {
  return evalNode(parseExpr(src), values);
}
