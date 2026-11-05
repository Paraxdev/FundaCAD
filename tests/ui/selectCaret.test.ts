import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

import { compileMainScss } from "./compileStyles";

const css = postcss.parse(compileMainScss());

/** Every declaration of a rule, at any depth, whose selector list holds a selector `pick` accepts. */
function decls(pick: (selector: string) => boolean, props: (prop: string) => boolean): string[] {
  const out: string[] = [];
  css.walkRules((rule: Rule) => {
    const hit = rule.selectors.filter(pick);
    if (hit.length === 0) return;
    rule.walkDecls((d) => {
      if (props(d.prop)) out.push(`${hit.join(", ")} { ${d.prop}: ${d.value} }`);
    });
  });
  return out;
}

// Every class a Select's trigger or value can carry: its own, its states and those its callers pass in.
const SELECT_CLASSES = [
  "sm-select",
  "select-trigger",
  "select-value",
  "ui-select-sm",
  "ui-select-md",
  "open",
  "is-open",
  ...Object.values(import.meta.glob("../../src/components/**/*.vue", { query: "?raw", import: "default", eager: true }))
    .flatMap((text) => [...(text as string).matchAll(/<Select\b(?:[^>"]|"[^"]*")*?\sclass="([^"]+)"/g)])
    .flatMap((m) => (m[1] ?? "").split(/\s+/)),
];

// Whatever sits inside :is() or :where() is part of the compound, so only top-level combinators split.
function lastCompound(selector: string): string {
  let depth = 0;
  let start = 0;
  [...selector].forEach((c, i) => {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (depth === 0 && /[\s>+~]/.test(c)) start = i + 1;
  });
  return selector.slice(start);
}

function stylesASelect(selector: string): boolean {
  const last = lastCompound(selector);
  return (
    /\[role=["']?combobox/.test(last) || SELECT_CLASSES.some((c) => new RegExp(String.raw`\.${c}(?![\w-])`).test(last))
  );
}

const MOVES = new Set(["transform", "translate", "rotate", "top", "bottom", "margin", "margin-top", "inset"]);

describe("the Select caret", () => {
  it("turns only when the list opens, by a rotate alone", () => {
    expect(
      decls(
        (s) => s.includes(".select-caret"),
        (p) => p === "transform" || p === "translate",
      ),
    ).toEqual([".select-trigger.is-open .select-caret { transform: rotate(90deg) }"]);
  });

  it("sits centred in the right gap by its insets, turns about its own centre and animates the turn", () => {
    expect(
      decls(
        (s) => s === ".select-caret",
        (p) => ["position", "top", "bottom", "margin", "transform-origin", "transition", "pointer-events"].includes(p),
      ),
    ).toEqual([
      ".select-caret { position: absolute }",
      ".select-caret { top: 0 }",
      ".select-caret { bottom: 0 }",
      ".select-caret { margin: auto 0 }",
      ".select-caret { transform-origin: center }",
      ".select-caret { pointer-events: none }",
      ".select-caret { transition: transform var(--t-fast) var(--ease) }",
    ]);
  });

  it("is not moved by any hover rule", () => {
    expect(
      decls(
        (s) => s.includes(".select-caret") && s.includes(":hover"),
        (p) => MOVES.has(p),
      ),
    ).toEqual([]);
  });

  it("keeps 26px on the right of a trigger in every rule that pads one, the room the caret is inset into", () => {
    const rights: string[] = [];
    css.walkRules((rule: Rule) => {
      const hit = rule.selectors.filter((s) => /\.(sm-select|select-trigger)\b/.test(s.split(/[\s>+~]+/).pop() ?? ""));
      if (hit.length === 0) return;
      rule.walkDecls(/^padding(-right|-inline|-inline-end)?$/, (d) => {
        const parts = postcss.list.space(d.value);
        const shorthand = d.prop === "padding" || d.prop === "padding-inline";
        rights.push(`${hit.join(", ")} ${shorthand ? (parts[1] ?? parts[0]) : d.value}`);
      });
    });
    expect(rights).toEqual([".sm-select 26px"]);
  });

  it("is no background paint of the trigger, so the bare button:hover shorthand has nothing to wipe or slide", () => {
    expect(
      decls(
        (s) => /\.(sm-select|select-trigger)\b/.test(s) && !s.includes("option"),
        (p) => p === "background-image" || p === "background-position" || p === "background-size",
      ),
    ).toEqual([]);
  });
});

describe("the Select value", () => {
  it("is centred by the trigger's flex, and no other rule on any Select takes that back", () => {
    expect(decls(stylesASelect, (p) => p === "display" || p === "align-items")).toEqual([
      ".select-trigger { display: flex }",
      ".select-trigger { align-items: center }",
      ".home-view-select { display: none }",
      "#stage.narrow .home-view-select { display: flex }",
    ]);
  });

  it("takes the width left beside the caret and can shrink below its text, so a long label still ellipsizes", () => {
    expect(
      decls(
        (s) => s === ".select-trigger .select-value",
        (p) => ["flex", "min-width", "overflow", "text-overflow", "white-space"].includes(p),
      ),
    ).toEqual([
      ".select-trigger .select-value { flex: 1 1 auto }",
      ".select-trigger .select-value { min-width: 0 }",
      ".select-trigger .select-value { overflow: hidden }",
      ".select-trigger .select-value { text-overflow: ellipsis }",
      ".select-trigger .select-value { white-space: nowrap }",
    ]);
  });
});
