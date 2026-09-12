// The viewport render settings: per-field sanitising of an untrusted stored
// value, and clamping rather than refusing a number.
//
// Modelled on tests/ui/layoutPrefs.test.ts, and here for the same reason: the
// value comes out of localStorage, where anything at all may be, and the failure
// mode of getting it wrong is a viewport that will not draw.

import { describe, expect, it } from "vitest";
import {
  BACKGROUND_COLOR,
  BLOOM_SETTINGS,
  DEFAULT_RENDER,
  MAX_BRIGHTNESS,
  MAX_EMISSIVE_INTENSITY,
  MIN_BRIGHTNESS,
  asBackground,
  asBloom,
  asBrightness,
  asEnvironment,
  asRenderPrefs,
} from "../../src/ui/renderPrefs";

describe("the field gates", () => {
  it("take what they know and refuse the rest", () => {
    expect(asEnvironment("studio")).toBe("studio");
    expect(asEnvironment("hdri")).toBeNull();
    expect(asBackground("grey")).toBe("grey");
    expect(asBackground("chartreuse")).toBeNull();
  });

  it("clamp a brightness instead of throwing it away", () => {
    expect(asBrightness(1.5)).toBe(1.5);
    expect(asBrightness(99)).toBe(MAX_BRIGHTNESS);
    expect(asBrightness(-4)).toBe(MIN_BRIGHTNESS);
    // Not a number at all is a different answer from out of range: there is
    // nothing to clamp towards, so it falls back to the default.
    expect(asBrightness("1.5")).toBeNull();
    expect(asBrightness(Number.NaN)).toBeNull();
    expect(asBrightness(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("asRenderPrefs", () => {
  it("sanitises PER FIELD, so one bad value costs only itself", () => {
    expect(asRenderPrefs({
      environment: "nonsense", background: "grey", brightness: 1.4, bloom: "strong",
      performanceMode: true,
    })).toEqual({
      environment: DEFAULT_RENDER.environment,
      background: "grey",
      brightness: 1.4,
      bloom: "strong",
      fov: DEFAULT_RENDER.fov,
      aperture: DEFAULT_RENDER.aperture,
      focusBlur: DEFAULT_RENDER.focusBlur,
      performanceMode: true,
    });
  });

  it("keeps performance mode only as a real boolean", () => {
    // A non-boolean (an old truthy "on" string, say) must not slip through as
    // the render tier, it decides glass vs alpha and the pixel ratio.
    expect(asRenderPrefs({ performanceMode: "yes" }).performanceMode).toBe(false);
    expect(asRenderPrefs({ performanceMode: true }).performanceMode).toBe(true);
  });

  it("fills in a field a stored setting predates", () => {
    // Every user who has ever changed a render setting has a stored object
    // written before this field existed, and it must read as the default rather
    // than as undefined, which would reach the renderer as "no such level".
    expect(asRenderPrefs({ environment: "none", background: "dark", brightness: 1 }).bloom)
      .toBe(DEFAULT_RENDER.bloom);
  });

  it("falls back whole for anything that is not an object", () => {
    for (const bad of [null, undefined, 7, "studio", [1, 2]]) {
      expect(asRenderPrefs(bad)).toEqual(DEFAULT_RENDER);
    }
  });
});

describe("the defaults", () => {
  it("keep reflections ON, which is what makes a metal look like metal", () => {
    // Not a preference dressed as a default. A physically-based metal is almost
    // all reflection, so with no environment it renders near black, and the
    // whole material library is unreadable. Turning it off is a choice; having
    // it off out of the box would look like a bug.
    expect(DEFAULT_RENDER.environment).toBe("studio");
    expect(DEFAULT_RENDER.brightness).toBe(1);
  });

  it("gives every fixed background a colour, and the theme one none", () => {
    expect(Object.keys(BACKGROUND_COLOR).sort()).toEqual(["dark", "grey", "light"]);
    expect("theme" in BACKGROUND_COLOR).toBe(false);
  });
});

describe("bloom", () => {
  it("names a level for each setting, and refuses anything else", () => {
    for (const good of ["off", "subtle", "strong"]) expect(asBloom(good)).toBe(good);
    for (const bad of ["SUBTLE", "", null, undefined, 1, {}, ["off"]]) {
      expect(asBloom(bad)).toBeNull();
    }
  });

  it("only spills light above full brightness, at the subtle level", () => {
    // THE tuning, and the reason it is safe to leave bloom on by default. The
    // pass runs on the LINEAR image before tone mapping, where an ordinary white
    // part under a key light at intensity 2 already sits above 1: measured at a
    // threshold of 0.85 the white test cylinder haloed as hard as the lit one
    // and the whole viewport went pale.
    expect(BLOOM_SETTINGS.subtle.threshold).toBeGreaterThan(1);
    // ...and strong is the one that reaches an ordinary highlight, or it would
    // be a second name for the same picture.
    expect(BLOOM_SETTINGS.strong.threshold).toBeLessThan(BLOOM_SETTINGS.subtle.threshold);
    expect(BLOOM_SETTINGS.strong.strength).toBeGreaterThan(BLOOM_SETTINGS.subtle.strength);
  });

  it("lets the Glow slider reach past the subtle threshold", () => {
    // CONTROL on the two numbers above being set independently: if the slider
    // could not push a material past the threshold, its top end would do
    // visibly nothing and an emissive material would never bloom at all, which
    // is the only thing bloom is for.
    expect(MAX_EMISSIVE_INTENSITY).toBeGreaterThan(BLOOM_SETTINGS.subtle.threshold);
  });
});
