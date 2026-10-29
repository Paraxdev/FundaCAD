import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

import { compileMainScss } from "./compileStyles";

const css = postcss.parse(compileMainScss());

// The winning value of one property on an element with exactly these classes, counting only
// root rules whose selector is a plain run of classes.
function cascaded(prop: string, classes: string[]): string | undefined {
  const set = new Set(classes);
  let best: { spec: number; value: string } | undefined;
  css.walkRules((rule: Rule) => {
    if (rule.parent?.type !== "root") return;
    for (const selector of rule.selectors) {
      const names = selector
        .trim()
        .match(/^((?:\.[\w-]+)+)$/)?.[1]
        ?.split(".")
        .filter(Boolean);
      if (!names || !names.every((n) => set.has(n))) continue;
      rule.walkDecls(prop, (d) => {
        if (!best || names.length >= best.spec) best = { spec: names.length, value: d.value };
      });
    }
  });
  return best?.value;
}

// The classes InlineLabel's sm TextField renders with while a tree row or folder is renamed.
const renameField = ["ui-field", "ui-text-field", "ui-field-sm", "tree-label", "renaming"];

describe("tree rename field", () => {
  it("is one line of the label's text tall, so a renaming row keeps its resting height", () => {
    expect(cascaded("height", renameField)).toBe("1lh");
  });

  it("falls back to its content height where the lh unit is missing, as on older WebKitGTK", () => {
    const heights: string[] = [];
    css.walkRules(".tree-label.renaming", (rule) => rule.walkDecls("height", (d) => void heights.push(d.value)));
    expect(heights).toEqual(["auto", "1lh"]);
  });

  it("sees the sm field height it has to beat", () => {
    expect(cascaded("height", ["ui-field", "ui-text-field", "ui-field-sm"])).toBe("24px");
  });
});
