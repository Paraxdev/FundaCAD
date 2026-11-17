// The hidden text the 3D view is described by, read on every focus of the view.
import { describe, expect, it } from "vitest";
import { selectionWords, standardViewOf, viewSummary, viewWords, type SummaryFacts } from "../../src/ui/viewSummary";

const facts = (over: Partial<SummaryFacts> = {}): SummaryFacts => ({
  bodies: 2,
  hidden: 0,
  features: 5,
  failed: 0,
  view: { view: "iso", ortho: false, section: false },
  selection: { bodies: [], faces: 0, edges: 0 },
  ...over,
});

describe("viewSummary", () => {
  it("says the bodies, features, view, section and selection in four short sentences", () => {
    expect(viewSummary(facts())).toBe(
      "2 bodies, 5 features. Isometric view, perspective. Section off. Nothing selected.",
    );
  });

  it("counts one of each in the singular and says when the model is empty", () => {
    expect(viewSummary(facts({ bodies: 1, features: 1 }))).toMatch(/^1 body, 1 feature\. /);
    expect(viewSummary(facts({ bodies: 0, features: 0 }))).toMatch(/^No bodies, no features\. /);
  });

  it("adds hidden bodies and failed features in brackets", () => {
    expect(viewSummary(facts({ bodies: 3, hidden: 1, features: 6, failed: 2 }))).toMatch(
      /^3 bodies \(1 hidden\), 6 features \(2 failed\)\. /,
    );
  });

  it("says an orthographic top view with the section on", () => {
    expect(viewSummary(facts({ view: { view: "top", ortho: true, section: true } }))).toContain(
      "Top view, orthographic. Section on.",
    );
  });

  it("stays short enough to hear on every focus", () => {
    const long = viewSummary(
      facts({
        bodies: 12,
        hidden: 3,
        features: 40,
        failed: 1,
        view: { view: null, ortho: true, section: true },
        selection: { bodies: [], faces: 4, edges: 2 },
      }),
    );
    expect(long.length).toBeLessThan(120);
  });
});

describe("viewWords", () => {
  it.each([
    ["front", "Front view"],
    ["back", "Back view"],
    ["left", "Left view"],
    ["right", "Right view"],
    ["bottom", "Bottom view"],
    [null, "Custom view"],
  ] as const)("names %s as %s", (view, words) => {
    expect(viewWords({ view, ortho: false, section: false })).toBe(`${words}, perspective`);
  });
});

describe("selectionWords", () => {
  it("names one selected body, and counts several", () => {
    expect(selectionWords({ bodies: ["Plate"], faces: 0, edges: 0 })).toBe("Selected: Plate");
    expect(selectionWords({ bodies: ["Plate", "Boss"], faces: 0, edges: 0 })).toBe("Selected: 2 bodies");
  });

  it("counts faces and edges together", () => {
    expect(selectionWords({ bodies: [], faces: 1, edges: 3 })).toBe("Selected: 1 face, 3 edges");
  });
});

describe("standardViewOf", () => {
  it("knows the view a camera eye direction is square to", () => {
    expect(standardViewOf([0, 0, 1])).toBe("top");
    expect(standardViewOf([0, -2, 0])).toBe("front");
    expect(standardViewOf([1, -1, 0.8])).toBe("iso");
  });

  it("calls a turned view no standard view", () => {
    expect(standardViewOf([0.3, -1, 0.2])).toBeNull();
    expect(standardViewOf([0, 0, 0])).toBeNull();
  });
});
