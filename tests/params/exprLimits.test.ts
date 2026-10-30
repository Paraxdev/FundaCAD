// The same limits fundacad-core holds (crates/fundacad-core/tests/expr_limits.rs), so the webview refuses what the
// engine refuses, and no document can overflow the webview's stack.

import { describe, it, expect } from "vitest";
import { ExprError, MAX_EXPR_DEPTH, MAX_EXPR_LEN, parseExpr, tokenize } from "../../src/params/parse";
import { evalExpr } from "../../src/params/eval";

function refused(src: string): string {
  try {
    parseExpr(src);
  } catch (e) {
    expect(e).toBeInstanceOf(ExprError);
    return (e as ExprError).message;
  }
  throw new Error(`${src.slice(0, 40)} parsed`);
}

const nested = (open: string, inner: string, close: string, n: number) => open.repeat(n) + inner + close.repeat(n);
const deeper = `expression nests deeper than ${MAX_EXPR_DEPTH} levels`;

describe("expression limits", () => {
  it("are the engine's", () => {
    expect([MAX_EXPR_LEN, MAX_EXPR_DEPTH]).toEqual([1024, 100]);
  });

  it("refuse deep parentheses, unary operators, call arguments and powers", () => {
    expect(refused(nested("(", "1", ")", 100_000))).toBe(`expression is longer than ${MAX_EXPR_LEN} characters`);
    expect(
      [
        nested("(", "1", ")", MAX_EXPR_DEPTH + 1),
        nested("-", "1", "", MAX_EXPR_DEPTH + 1),
        nested("!", "1", "", MAX_EXPR_DEPTH + 1),
        nested("max(1;", "1", ")", MAX_EXPR_DEPTH + 1),
        nested("2^", "2", "", MAX_EXPR_DEPTH + 1),
      ].map(refused),
    ).toEqual([deeper, deeper, deeper, deeper, deeper]);
  });

  it("refuse a long flat expression before it is tokenized", () => {
    const src = Array<string>(MAX_EXPR_LEN / 2 + 1)
      .fill("1")
      .join("+");
    expect(refused(src)).toBe(`expression is longer than ${MAX_EXPR_LEN} characters`);
    expect(() => tokenize(src)).toThrow(ExprError);
  });

  it("let expressions at the limits parse and evaluate", () => {
    const depth = MAX_EXPR_DEPTH - 1;
    const flat = Array<string>(MAX_EXPR_LEN / 2)
      .fill("1")
      .join("+");
    expect(flat.length).toBeLessThanOrEqual(MAX_EXPR_LEN);
    expect(
      [nested("(", "1", ")", depth), nested("max(1;", "1", ")", depth), nested("-", "1", "", depth), flat].map((s) =>
        evalExpr(s, {}),
      ),
    ).toEqual([1, 1, -1, MAX_EXPR_LEN / 2]);
  });
});
