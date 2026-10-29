import postcss from "postcss";
import { describe, expect, it } from "vitest";

import { compileMainScss } from "./compileStyles";

describe("Button cascade", () => {
  it("takes the UI face from its surroundings, not the browser's button face", () => {
    const families: string[] = [];
    postcss.parse(compileMainScss()).walkRules((rule) => {
      if (rule.selectors.includes(".btn.btn-sm") && rule.selectors.includes(".btn.btn-md"))
        rule.walkDecls("font-family", (d) => void families.push(d.value));
    });
    expect(families).toEqual(["inherit"]);
  });

  it("keeps a pressed ghost button's accent ink under the pointer", () => {
    const hover: string[] = [];
    postcss.parse(compileMainScss()).walkRules((rule) => {
      for (const sel of rule.selectors) if (sel.startsWith(".btn.btn-ghost:hover")) hover.push(sel);
    });
    expect(hover.length).toBeGreaterThan(0);
    for (const sel of hover) expect(sel).toContain(".is-on");
  });
});
