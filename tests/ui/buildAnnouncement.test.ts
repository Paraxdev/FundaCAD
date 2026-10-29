import { describe, expect, it } from "vitest";
import { buildLine } from "../../src/ui/buildAnnouncement";

const settled = (over: Partial<Parameters<typeof buildLine>[0]> = {}): Parameters<typeof buildLine>[0] => ({
  building: false,
  errorFeatureId: null,
  errorMessage: null,
  cancelled: false,
  previewBuilt: null,
  result: { bodies: [{}, {}] },
  ...over,
});
const names = (id: string) => (id === "f2" ? "Extrude 2" : null);

describe("buildLine", () => {
  it("says nothing while building or for a tool's live preview", () => {
    expect(buildLine(settled({ building: true }), null, names)).toBeNull();
    expect(buildLine(settled({ previewBuilt: [] }), null, names)).toBeNull();
  });

  it("says a clean build politely with its body count", () => {
    expect(buildLine(settled(), null, names)).toEqual({ text: "Built, 2 bodies", priority: "polite" });
    expect(buildLine(settled({ result: { bodies: [{}] } }), null, names)?.text).toBe("Built, 1 body");
    expect(buildLine(settled({ result: null }), null, names)?.text).toBe("Built");
  });

  it("says a cancelled build politely", () => {
    expect(buildLine(settled({ cancelled: true }), null, names)).toEqual({
      text: "Build cancelled",
      priority: "polite",
    });
  });

  it("says a new failure assertively, with the step and the reason", () => {
    const now = settled({ errorFeatureId: "f2", errorMessage: " Profile is open " });
    expect(buildLine(now, settled(), names)).toEqual({
      text: "Build failed at Extrude 2: Profile is open",
      priority: "assertive",
    });
    expect(buildLine(settled({ errorMessage: "Engine stopped" }), null, names)?.text).toBe(
      "Build failed: Engine stopped",
    );
  });

  it("says a failure that is still there after the next edit politely", () => {
    const fail = settled({ errorFeatureId: "f2", errorMessage: "Profile is open" });
    expect(buildLine(fail, fail, names)).toEqual({
      text: "Built, 2 bodies, Extrude 2 still fails",
      priority: "polite",
    });
    const unnamed = settled({ errorFeatureId: "gone", errorMessage: "x" });
    expect(buildLine(unnamed, unnamed, names)?.text).toBe("Built, 2 bodies, a feature still fails");
  });

  it("says a different failure assertively again", () => {
    const before = settled({ errorFeatureId: "f2", errorMessage: "Profile is open" });
    const after = settled({ errorFeatureId: "f2", errorMessage: "Depth is zero" });
    expect(buildLine(after, before, names)?.priority).toBe("assertive");
  });
});
