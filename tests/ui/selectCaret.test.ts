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
