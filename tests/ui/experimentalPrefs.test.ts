// Preferences, Experimental: the defaults are the limits as they always were, a raised value reaches both tracers,
// and Reset brings every one back.

import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asExperimentalPrefs,
  DEFAULT_EXPERIMENTAL,
  experimentalPrefs,
  lightingEnvWidth,
  onExperimentalPrefsChange,
  resetExperimentalPrefs,
  setExperimentalPref,
  storedEnvWidth,
} from "../../src/ui/experimentalPrefs";
import { costProfile, maxPicturePixels, renderScaleFor, tracedPictureScale } from "../../src/viewport/pathtrace/budget";
import { SAMPLE_CAP, type TraceLook } from "../../src/viewport/pathtrace/backend";
import { nativeLook } from "../../src/viewport/pathtrace/nativeScene";
import { lookSignature } from "../../src/viewport/pathtrace/host";
import { TRIANGLE_BUDGET } from "../../src/viewport/pathtrace/mirror";
import { hdrLightingWidth, hdrStoredWidth, setHdrTextureMax } from "../../src/viewport/hdrRegistry";

afterEach(() => {
  resetExperimentalPrefs();
  setHdrTextureMax(8192);
});

const look = (o: Partial<TraceLook> = {}): TraceLook => ({
  lights: [],
  background: new THREE.Color(0, 0, 0),
  environment: new THREE.Texture(),
  brightness: 1,
  toneMapping: THREE.NeutralToneMapping,
  exposure: 1,
  ...o,
});

describe("experimental limits", () => {
  it("default to the limits the app has always kept", () => {
    expect(DEFAULT_EXPERIMENTAL).toEqual({
      envWidth: 2048,
      sampleCap: SAMPLE_CAP,
      batterySampleCap: 64,
      bounces: 6,
      firefly: 10,
      traceScale: 0,
      pictureMegapixels: (3840 * 2160) / 1e6,
      triangleBudget: TRIANGLE_BUDGET,
    });
    expect(experimentalPrefs()).toEqual(DEFAULT_EXPERIMENTAL);
    expect(costProfile({ discharging: false })).toEqual({ cap: 256, budgetScale: 1 });
    expect(costProfile({ discharging: true })).toEqual({ cap: 64, budgetScale: 0.5 });
    expect(maxPicturePixels()).toBe(3840 * 2160);
    expect(hdrStoredWidth()).toBe(2048);
    expect(hdrLightingWidth()).toBe(1024);
  });

  it("narrow stored JSON field by field and clamp to their ranges", () => {
    const p = asExperimentalPrefs({ envWidth: 3000, sampleCap: 1e9, bounces: 2.6, firefly: "x", traceScale: 0.9 });
    expect(p.envWidth).toBe(2048);
    expect(p.sampleCap).toBe(65536);
    expect(p.bounces).toBe(3);
    expect(p.firefly).toBe(10);
    expect(p.traceScale).toBe(0.9);
    expect(asExperimentalPrefs(null)).toEqual(DEFAULT_EXPERIMENTAL);
  });

  it("keep the firefly clamp within a sensible ceiling, and 0 stays off", () => {
    expect(asExperimentalPrefs({ firefly: 1e6 }).firefly).toBe(1000);
    expect(asExperimentalPrefs({ firefly: 0 }).firefly).toBe(0);
  });

  it("store only what differs from the defaults, and Reset clears it", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    let heard = 0;
    const off = onExperimentalPrefsChange(() => heard++);
    setExperimentalPref("bounces", 12);
    expect(JSON.parse(localStorage.getItem("fundacad.experimental")!)).toEqual({ bounces: 12 });
    resetExperimentalPrefs();
    expect(localStorage.getItem("fundacad.experimental")).toBeNull();
    expect(heard).toBe(2);
    off();
    vi.unstubAllGlobals();
  });

  it("raise the sample caps, the trace resolution and the picture size", () => {
    setExperimentalPref("sampleCap", 2048);
    setExperimentalPref("batterySampleCap", 512);
    expect(costProfile({ discharging: false }).cap).toBe(2048);
    expect(costProfile({ discharging: true }).cap).toBe(512);
    expect(renderScaleFor({ cssHeight: 900, dpr: 1, discharging: false })).toBe(0.75);
    setExperimentalPref("traceScale", 1);
    expect(renderScaleFor({ cssHeight: 900, dpr: 1, discharging: false })).toBe(1);
    expect(tracedPictureScale(1000, 1000, 16, 1e6)).toBeCloseTo(Math.sqrt(8.2944), 2);
    setExperimentalPref("pictureMegapixels", 100);
    expect(tracedPictureScale(1000, 1000, 16, 1e6)).toBe(10);
  });

  it("send the bounces and the firefly clamp to the native tracer and restart the trace on a change", () => {
    const a = look({ bounces: 6, firefly: 10 });
    expect(nativeLook(a)).toMatchObject({ bounces: 6, firefly: 10 });
    const b = look({ bounces: 24, firefly: 0 });
    expect(nativeLook(b)).toMatchObject({ bounces: 24, firefly: 0 });
    expect(lookSignature(a)).not.toBe(lookSignature(b));
    expect(nativeLook(look())).not.toHaveProperty("bounces");
  });

  it("keep an imported panorama larger, up to the GPU's largest texture", () => {
    setHdrTextureMax(16384);
    setExperimentalPref("envWidth", 8192);
    expect([hdrStoredWidth(), hdrLightingWidth()]).toEqual([8192, 4096]);
    setExperimentalPref("envWidth", "gpu");
    expect(hdrStoredWidth()).toBe(16384);
    expect(storedEnvWidth({ ...DEFAULT_EXPERIMENTAL, envWidth: 16384 }, 8192)).toBe(8192);
    expect(lightingEnvWidth(DEFAULT_EXPERIMENTAL, 16384)).toBe(1024);
  });
});
