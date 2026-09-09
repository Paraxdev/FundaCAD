// The viewport render settings: per-field sanitising of an untrusted stored
// value, and clamping rather than refusing a number.
//
// Modelled on tests/ui/layoutPrefs.test.ts, and here for the same reason: the
// value comes out of localStorage, where anything at all may be, and the failure
// mode of getting it wrong is a viewport that will not draw.

import { describe, expect, it } from "vitest";
import {
  asBackground, asBrightness, asEnvironment, asRenderPrefs, BACKGROUND_COLOR,
  DEFAULT_RENDER, MAX_BRIGHTNESS, MIN_BRIGHTNESS,
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
    expect(asRenderPrefs({ environment: "nonsense", background: "grey", brightness: 1.4 })).toEqual({
      environment: DEFAULT_RENDER.environment,
      background: "grey",
      brightness: 1.4,
    });
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
