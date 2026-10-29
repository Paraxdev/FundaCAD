import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

import { compileMainScss } from "./compileStyles";

const css = postcss.parse(compileMainScss());

// Specificity of a selector made only of a tag, classes and :hover, or null when
// it carries a combinator or any other pseudo, or names something the element
// lacks, so the rule cannot apply to a bare `<button class="...">`.
function specificityFor(selector: string, tag: string, classes: Set<string>, hover: boolean): [number, number] | null {
  if (/[\s>+~[\]#*]/.test(selector.trim())) return null;
  const parts = selector.trim().match(/^([a-z][a-z0-9-]*)?((?:\.[\w-]+)*)((?::hover)?)$/i);
  if (!parts) return null;
  const [, type, cls, pseudo] = parts;
  if (type && type !== tag) return null;
  const names = (cls ?? "").split(".").filter(Boolean);
  if (!names.every((n) => classes.has(n))) return null;
  if (pseudo && !hover) return null;
  return [names.length + (pseudo ? 1 : 0), type ? 1 : 0];
}

// The winning value of one property on a bare `<button>` with these classes.
function cascaded(prop: string, classes: string[], hover = false): string | undefined {
  const set = new Set(classes);
  let best: { spec: [number, number]; value: string } | undefined;
  css.walkRules((rule: Rule) => {
    if (rule.parent?.type !== "root") return;
    for (const selector of rule.selectors) {
      const spec = specificityFor(selector, "button", set, hover);
      if (!spec) continue;
      rule.walkDecls(prop, (d) => {
        const beats = !best || spec[0] > best.spec[0] || (spec[0] === best.spec[0] && spec[1] >= best.spec[1]);
        if (beats) best = { spec, value: d.value };
      });
    }
  });
  return best?.value;
}

// A rail button draws no fill of its own: the lit look lives on its tile, so a
// fill from the generic `button.active` would show as a slab behind tile and pill.
describe("a rail button paints no fill on any state", () => {
  it.each([
    ["idle", ["rail-btn"], false],
    ["hovered", ["rail-btn"], true],
    ["active", ["rail-btn", "active"], false],
    ["active and hovered", ["rail-btn", "active"], true],
    ["held", ["rail-btn", "holding"], false],
    ["active and held", ["rail-btn", "active", "holding"], false],
    ["disabled", ["rail-btn", "disabled"], false],
  ] as const)("%s", (_state, classes, hover) => {
    expect(cascaded("background", [...classes], hover)).toBe("none");
  });

  it("sees the generic fill the rail button has to beat", () => {
    expect(cascaded("background", ["active"])).toBe("var(--accent-tint)");
  });
});
