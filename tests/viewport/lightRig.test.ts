import { describe, expect, it } from "vitest";
import { DEFAULT_RENDER } from "../../src/ui/renderPrefs";
import { keyDirection } from "../../src/viewport/keyLight";
import {
  buildLightRig,
  environmentKeyOf,
  hemisphereKey,
  lightOf,
  scaled,
  type LightRig,
} from "../../src/viewport/lightRig";

const HASH = "0123456789abcdef";
const none = () => false;
const prefs = (o: Partial<typeof DEFAULT_RENDER> = {}) => ({ ...DEFAULT_RENDER, ...o });

describe("light rig", () => {
  it("defaults equal the constants the scene has always used", () => {
    const rig = buildLightRig(DEFAULT_RENDER, none);
    const key = lightOf(rig, "key")!;
    const fill = lightOf(rig, "fill")!;
    const old = (v: number[]) => {
      const n = Math.hypot(v[0]!, v[1]!, v[2]!);
      return v.map((c) => c / n);
    };
    key.direction.forEach((c, i) => expect(c).toBeCloseTo(old([40, -60, 80])[i]!, 12));
    fill.direction.forEach((c, i) => expect(c).toBeCloseTo(old([-50, 40, 20])[i]!, 12));
    expect([key.intensity, fill.intensity, rig.hemisphere.intensity]).toEqual([2.0, 0.6, 0.6]);
    expect([rig.hemisphere.sky, rig.hemisphere.ground]).toEqual([0xbfd4ff, 0x202428]);
    expect(rig.hemisphere.up).toEqual([0, 1, 0]);
    expect(rig.brightness).toBe(1);
    expect(rig.background).toBe("theme");
  });

  it("is built from the prefs", () => {
    const rig = buildLightRig(prefs({ keyAzimuth: 30, keyElevation: 50, brightness: 1.5, background: "grey" }), none);
    expect(lightOf(rig, "key")!.direction).toEqual(keyDirection(30, 50));
    expect(rig.brightness).toBe(1.5);
    expect(rig.background).toBe("grey");
  });

  it("gives the key a 1 degree radius and no realtime only light yet", () => {
    const rig = buildLightRig(DEFAULT_RENDER, none);
    expect(lightOf(rig, "key")!.angularRadius).toBe(1);
    expect(rig.lights.every((l) => !l.realtimeOnly)).toBe(true);
  });

  it("applies the brightness once per part", () => {
    const rig = buildLightRig(prefs({ brightness: 1.5 }), none);
    expect(scaled(rig, lightOf(rig, "key")!.intensity)).toBeCloseTo(3.0, 12);
    expect(scaled(rig, lightOf(rig, "fill")!.intensity)).toBeCloseTo(0.9, 12);
    expect(scaled(rig, rig.hemisphere.intensity)).toBeCloseTo(0.9, 12);
    expect(rig.hemisphere.intensity).toBe(0.6);
  });

  it("includes the hemisphere in the environment key", () => {
    const rig = buildLightRig(prefs({ environment: "none" }), none);
    expect(rig.environment.key).toBeNull();
    expect(rig.environment.fullKey).toBeNull();
    const lit = buildLightRig(prefs({ environment: `hdr:${HASH}`, envRotation: 90 }), (h) => h === HASH);
    expect(lit.environment.key).toBe(environmentKeyOf(prefs({ environment: `hdr:${HASH}`, envRotation: 90 }), (h) => h === HASH));
    expect(lit.environment.fullKey).toBe(`${lit.environment.key}|${hemisphereKey(lit.hemisphere)}`);
    const other: LightRig = { ...lit, hemisphere: { ...lit.hemisphere, intensity: 0.7 } };
    expect(hemisphereKey(other.hemisphere)).not.toBe(hemisphereKey(lit.hemisphere));
  });

  it("has no key for a panorama that has not loaded", () => {
    expect(buildLightRig(prefs({ environment: `hdr:${HASH}` }), none).environment.key).toBeNull();
  });

  it("carries a ground that is off until a pref turns it on", () => {
    expect(buildLightRig(DEFAULT_RENDER, none).ground.mode).toBe("none");
  });
});
