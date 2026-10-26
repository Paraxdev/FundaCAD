// Linear and Circular lead every pattern entry point, the rectangular grid is the third choice.
import { describe, it, expect } from "vitest";
import { modelGroups, SKETCH, leavesOf } from "../../src/ui/ribbonDefs";
import { sketchRail } from "../../src/ui/railDefs";

const names = (actions: string[]) => actions.filter((a) => /pattern/i.test(a));

describe("pattern order", () => {
  it("the model ribbon offers Linear, Circular, then Rect", () => {
    const all = modelGroups().flatMap((g) => g.items.flatMap(leavesOf).map((l) => l.action));
    expect(names(all as string[])).toEqual(["pattern-linear", "pattern-circular", "pattern-rect"]);
  });

  it("the sketch ribbon offers Linear, Circular, then Rect", () => {
    const all = SKETCH.flatMap((g) => g.items.flatMap(leavesOf).map((l) => l.action));
    expect(names(all as string[])).toEqual(["patternLinear", "patternCircular", "patternRect"]);
  });

  it("the sketch rail's pattern tile leads with Linear then Circular then Rect", () => {
    const fam = sketchRail().find((e) => e.kind === "family" && e.id === "fam:pattern");
    const items = fam && fam.kind === "family" ? fam.items : [];
    expect(items.slice(0, 3).map((t) => t.action)).toEqual(["patternLinear", "patternCircular", "patternRect"]);
    expect(items[0]?.label).toBe("Linear Pattern");
    expect(items[2]?.label).toBe("Rect Pattern");
  });
});
