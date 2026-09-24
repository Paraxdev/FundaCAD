import { describe, expect, it } from "vitest";
import { DEFAULT_KEY, keyAngles, keyDirection } from "../../src/viewport/keyLight";
import { asAzimuth, asElevation, asRenderPrefs, DEFAULT_RENDER } from "../../src/ui/renderPrefs";

describe("key light angles", () => {
  it("default to the direction the rig has always lit from", () => {
    const d = keyDirection(DEFAULT_KEY.azimuth, DEFAULT_KEY.elevation);
    const len = Math.hypot(40, -60, 80);
    expect(d[0]).toBeCloseTo(40 / len, 12);
    expect(d[1]).toBeCloseTo(-60 / len, 12);
    expect(d[2]).toBeCloseTo(80 / len, 12);
    expect(DEFAULT_RENDER.keyAzimuth).toBe(DEFAULT_KEY.azimuth);
    expect(DEFAULT_RENDER.keyElevation).toBe(DEFAULT_KEY.elevation);
  });

  it("round-trip through a direction", () => {
    for (const [az, el] of [[0, 0], [90, 30], [-135, 60], [180, -20], [45, 89]] as const) {
      const a = keyAngles(keyDirection(az, el));
      expect(a.azimuth).toBeCloseTo(az, 9);
      expect(a.elevation).toBeCloseTo(el, 9);
    }
  });

  it("measure azimuth from +X towards +Y and elevation up Z", () => {
    expect(keyDirection(90, 0).map((x) => +x.toFixed(12))).toEqual([0, 1, 0]);
    expect(keyDirection(0, 90).map((x) => +x.toFixed(12))).toEqual([0, 0, 1]);
  });

  it("are stored folded and clamped", () => {
    expect(asAzimuth(270)).toBe(-90);
    expect(asAzimuth(-180)).toBe(180);
    expect(asElevation(120)).toBe(90);
    expect(asAzimuth("x")).toBeNull();
    const p = asRenderPrefs({ keyAzimuth: 30, keyElevation: "high" });
    expect(p.keyAzimuth).toBe(30);
    expect(p.keyElevation).toBe(DEFAULT_KEY.elevation);
  });
});
