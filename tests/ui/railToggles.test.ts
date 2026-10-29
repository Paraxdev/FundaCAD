import { describe, expect, it } from "vitest";
import { railToggles } from "../../src/ui/railActive";

describe("which rail tools say pressed", () => {
  it("counts every sketch tool and the analysis views, and leaves one shot model tools out", () => {
    expect({
      sketch: ["line", "rectangle", "horizontal"].map((a) => railToggles(a, "sketch")),
      views: ["zebra", "curvature", "component-colors", "draft-analysis"].map((a) => railToggles(a, "model")),
      oneShot: ["extrude", "fillet", "offer:mirror", "look:hide"].map((a) => railToggles(a, "selection")),
    }).toEqual({
      sketch: [true, true, true],
      views: [true, true, true, true],
      oneShot: [false, false, false, false],
    });
  });
});
