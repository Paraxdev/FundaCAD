// A busy sketch squeezed the Relations and Shapes lists to a few pixels: the card scrolls as one instead.
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

import { compileMainScss } from "./compileStyles";

const css = postcss.parse(compileMainScss());
const SIZING = ["flex", "flex-shrink", "flex-basis", "min-height", "max-height", "height", "overflow", "overflow-y"];

function decls(selector: string): string[] {
  const out: string[] = [];
  css.walkRules((rule: Rule) => {
    if (rule.parent?.type !== "root" || !rule.selectors.includes(selector)) return;
    rule.walkDecls((d) => {
      if (SIZING.includes(d.prop)) out.push(`${d.prop}: ${d.value}`);
    });
  });
  return out;
}

describe("the sketch palette in a busy sketch", () => {
  it("scrolls the whole card once it meets the viewport", () => {
    expect(decls(".palette")).toEqual(["max-height: calc(100% - var(--s-4) * 2)", "overflow-y: auto"]);
    expect(decls(".float-right .palette")).toEqual(["max-height: 100%"]);
  });

  it("never shrinks a card child, so each list keeps its rows up to its own scroll", () => {
    expect(decls(".palette > *")).toEqual(["flex: none"]);
    expect(decls(".rel-list")).toEqual(["max-height: 216px", "overflow-y: auto"]);
    expect(decls(".dim-list")).toEqual(["max-height: 216px", "overflow-y: auto"]);
  });
});
