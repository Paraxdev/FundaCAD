// The viewport no longer draws on every pointer move, so a region hover has to
// say when it changed for its wiring to ask for the frame.
import { describe, expect, it } from "vitest";
import { SketchOverlay, type WorldRegion } from "../../src/sketch/overlay";

describe("SketchOverlay.setHoverRegion", () => {
  it("reports a change only when the hovered region is a different one", () => {
    const o = new SketchOverlay();
    const a = {} as WorldRegion;
    const b = {} as WorldRegion;
    expect(o.setHoverRegion(null)).toBe(false);
    expect(o.setHoverRegion(a)).toBe(true);
    expect(o.setHoverRegion(a)).toBe(false);
    expect(o.setHoverRegion(b)).toBe(true);
    expect(o.setHoverRegion(null)).toBe(true);
  });
});
