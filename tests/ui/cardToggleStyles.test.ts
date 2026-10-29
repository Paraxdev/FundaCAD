import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

import { compileMainScss } from "./compileStyles";

const css = postcss.parse(compileMainScss());

function decls(selector: string, props: string[]): string[] {
  const out: string[] = [];
  css.walkRules((rule: Rule) => {
    if (rule.parent?.type !== "root" || !rule.selectors.includes(selector)) return;
    rule.walkDecls((d) => {
      if (props.includes(d.prop)) out.push(`${d.prop}: ${d.value}`);
    });
  });
  return out;
}

describe("the collapsible Card head", () => {
  it("lets the toggle fill its title heading, so the whole head row beside the actions folds the card", () => {
    expect(decls(".ui-card-toggle", ["display", "width"])).toEqual(["display: flex", "width: 100%"]);
  });

  it("keeps the title heading growing into the head row with no heading margin", () => {
    expect(decls(".float-card-title", ["flex", "margin"])).toEqual(["flex: 1 1 auto", "margin: 0"]);
  });
});
