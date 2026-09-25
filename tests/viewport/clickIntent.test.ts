import { describe, expect, it } from "vitest";
import { clickTakes, DwellIntent } from "../../src/viewport/clickIntent";

const none = new Set<string>();

describe("clickTakes", () => {
  it("takes the body on a first click", () => {
    expect(clickTakes({ bodyId: "a", additive: false, selectedBodies: [], drilledBodies: none })).toBe("body");
  });

  it("takes the face on a click on the body already selected", () => {
    expect(clickTakes({ bodyId: "a", additive: false, selectedBodies: ["a"], drilledBodies: none })).toBe("part");
  });

  it("moves to another body whole", () => {
    expect(clickTakes({ bodyId: "b", additive: false, selectedBodies: ["a"], drilledBodies: none })).toBe("body");
    expect(clickTakes({ bodyId: "b", additive: false, selectedBodies: [], drilledBodies: new Set(["a"]) })).toBe("body");
  });

  it("keeps picking faces on a body it is already inside", () => {
    expect(clickTakes({ bodyId: "a", additive: false, selectedBodies: [], drilledBodies: new Set(["a"]) })).toBe("part");
  });

  it("Ctrl adds bodies to bodies and faces to faces", () => {
    expect(clickTakes({ bodyId: "a", additive: true, selectedBodies: ["a", "b"], drilledBodies: none })).toBe("body");
    expect(clickTakes({ bodyId: "b", additive: true, selectedBodies: [], drilledBodies: new Set(["a"]) })).toBe("part");
  });

  it("leaves empty space to the ordinary pick", () => {
    expect(clickTakes({ bodyId: null, additive: false, selectedBodies: ["a"], drilledBodies: none })).toBe("part");
  });
});

describe("DwellIntent", () => {
  const DWELL = 800;

  it("counts a pause over a body", () => {
    const d = new DwellIntent();
    expect(d.hover("a", 0)).toBe(true);
    expect(d.hover("a", 500)).toBe(false);
    expect(d.dwelt("a", 700, DWELL)).toBe(false);
    expect(d.dwelt("a", 800, DWELL)).toBe(true);
  });

  it("FI-3: a hover from before an orbit does not count as a pause after it", () => {
    // Hover the body, orbit with a button held, come back over the same body
    // and click at once: the click takes the body, whatever the orbit took.
    const d = new DwellIntent();
    d.hover("a", 0);
    d.held();
    expect(d.hover("a", 3000)).toBe(true);
    const dwelt = d.dwelt("a", 3000, DWELL);
    expect(dwelt).toBe(false);
    const takes = dwelt
      ? "part"
      : clickTakes({ bodyId: "a", additive: false, selectedBodies: [], drilledBodies: none });
    expect(takes).toBe("body");
  });

  it("starts over on another body or on empty space", () => {
    const d = new DwellIntent();
    d.hover("a", 0);
    expect(d.hover("b", 900)).toBe(true);
    expect(d.dwelt("b", 1000, DWELL)).toBe(false);
    d.hover(null, 1000);
    expect(d.isOn("b")).toBe(false);
  });
});
