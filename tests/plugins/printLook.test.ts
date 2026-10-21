import { describe, expect, it } from "vitest";

import { DEFAULTS, DIRECTIONS, reliefFrom } from "../../plugins/FundaCAD.PrintLook/look";

describe("Printed look settings to a Relief", () => {
  it("draws nothing while layer lines are off, which is the default", () => {
    expect(reliefFrom(DEFAULTS)).toBeNull();
  });

  it("maps the defaults to the declared look", () => {
    expect(reliefFrom({ ...DEFAULTS, layerLines: true })).toEqual({
      axis: [0, 0, 1], pitch: 0.2, depth: 0.35, tintJitter: 0.03, cavity: 0.4,
    });
  });

  it("turns each of the six directions into a unit axis", () => {
    expect(DIRECTIONS.map((d) => d.id)).toEqual(["+Z", "-Z", "+X", "-X", "+Y", "-Y"]);
    for (const d of DIRECTIONS) {
      const r = reliefFrom({ ...DEFAULTS, layerLines: true, direction: d.id })!;
      expect(r.axis).toEqual(d.axis);
      expect(Math.hypot(...r.axis)).toBe(1);
    }
  });

  it("clamps what the viewport cannot draw and falls back on rubbish", () => {
    const r = reliefFrom({ layerLines: true, layerHeight: 0, depth: 9, variation: -1, grooveShading: 4, direction: "up" })!;
    expect(r.pitch).toBeGreaterThan(0);
    expect(r.depth).toBe(0.5);
    expect(r.tintJitter).toBe(0);
    expect(r.cavity).toBe(1);
    expect(r.axis).toEqual([0, 0, 1]);
    expect(reliefFrom({ layerLines: true, layerHeight: NaN })!.pitch).toBe(0.2);
  });
});
