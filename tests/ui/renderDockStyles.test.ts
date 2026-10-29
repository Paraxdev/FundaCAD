import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

import { compileMainScss } from "./compileStyles";

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

describe("the Render dock styles", () => {
  it("gives every slider readout the old 34px column, so a drag cannot resize the track", () => {
    expect(decls("#renderdock .ui-slider-value")).toEqual({ "min-width": "34px" });
  });

  it("spaces an on/off row away from the hint above it", () => {
    expect(decls(".sm-hint + .rd-check")).toEqual({ "margin-top": "var(--s-2)" });
  });

  it("keeps no rules for the tab and readout classes the base Tabs and Slider replaced", () => {
    expect([decls(".rd-tab"), decls(".rd-tab:hover"), decls(".rd-tab.active"), decls(".rd-value")]).toEqual([
      {},
      {},
      {},
      {},
    ]);
  });
});
