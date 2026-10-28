import postcss from "postcss";
import { describe, expect, it } from "vitest";

import { compileMainScss } from "./compileStyles";

describe("Button font", () => {
  it("takes the UI face from its surroundings, not the browser's button face", () => {
    const families: string[] = [];
    postcss.parse(compileMainScss()).walkRules((rule) => {
      if (rule.selectors.includes(".btn.btn-sm") && rule.selectors.includes(".btn.btn-md"))
        rule.walkDecls("font-family", (d) => void families.push(d.value));
    });
    expect(families).toEqual(["inherit"]);
  });
});
