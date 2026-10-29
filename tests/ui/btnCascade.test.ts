import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

import { compileMainScss } from "./compileStyles";

const sources = import.meta.glob("../../src/styles/*.scss", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const modalsSrc = Object.entries(sources).find(([path]) => path.endsWith("/_modals.scss"))?.[1] ?? "";

const css = postcss.parse(compileMainScss());

function decls(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  css.walkRules((rule: Rule) => {
    if (rule.parent?.type !== "root") return;
    if (!rule.selectors.map((s) => s.trim()).includes(selector)) return;
    rule.walkDecls((d) => {
      out[d.prop] = d.value;
    });
  });
  return out;
}

function splitTop(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  return [...out, list.slice(start)];
}

// [ids, classes and pseudo-classes, types]; :is and :not count as their most specific argument.
function specificity(selector: string): [number, number, number] {
  let s = selector.trim();
  const spec: [number, number, number] = [0, 0, 0];
  const nested = /:(?:is|not)\(/;
  for (let m = nested.exec(s); m; m = nested.exec(s)) {
    let depth = 1;
    let end = m.index + m[0].length;
    for (; depth > 0; end++) depth += s[end] === "(" ? 1 : s[end] === ")" ? -1 : 0;
    const inner = s.slice(m.index + m[0].length, end - 1);
    const best = splitTop(inner)
      .map(specificity)
      .reduce((a, b) => (compare(a, b) >= 0 ? a : b));
    spec[0] += best[0];
    spec[1] += best[1];
    spec[2] += best[2];
    s = s.slice(0, m.index) + s.slice(end);
  }
  spec[0] += (s.match(/#[\w-]+/g) ?? []).length;
  spec[1] += (s.match(/\.[\w-]+|:[\w-]+|\[[^\]]*\]/g) ?? []).length;
  spec[2] += (s.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length;
  return spec;
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const disabled = ".btn:is(:disabled, .is-disabled)";
const hover = ".btn:hover:not(:disabled, .is-disabled)";

describe("the one .btn rule", () => {
  it("holds the base look on .btn itself, rounded without the bare button rule", () => {
    expect(decls(".btn")).toEqual({
      "corner-shape": "squircle",
      "border-radius": "var(--float-chip-radius)",
      "--btn-fill": "var(--float-chip-bg)",
      "--btn-hover": "linear-gradient(var(--hover-wash), var(--hover-wash)), var(--float-chip-bg)",
      padding: "var(--s-3) var(--s-4)",
      "font-size": "12px",
      "font-weight": "500",
      color: "var(--text)",
      background: "var(--btn-fill)",
      border: "1px solid transparent",
      "box-shadow": "none",
      cursor: "pointer",
      transition:
        "background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease)",
    });
  });

  it("dims a disabled .btn, native or .is-disabled, and keeps its fill", () => {
    expect(decls(disabled)).toEqual({ background: "var(--btn-fill)", opacity: "0.45", cursor: "default" });
  });

  it("lights only an enabled .btn on hover", () => {
    expect(decls(hover)).toEqual({ background: "var(--btn-hover)" });
  });

  it("lets the disabled look beat the bare button:hover paint", () => {
    expect(decls("button:hover")).toEqual({ background: "var(--raised)" });
    expect(compare(specificity(disabled), specificity("button:hover"))).toBeGreaterThan(0);
  });

  it("is not redefined in _modals.scss", () => {
    expect(modalsSrc.match(/^[^\n{]*\.btn\b[^\n{]*\{/gm)).toBeNull();
  });
});
